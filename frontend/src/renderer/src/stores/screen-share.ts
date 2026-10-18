import { create } from 'zustand';
import {
  AudioPresets,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Track,
  TrackEvent,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import { errorMessage } from '../lib/api';
import {
  describeDecision,
  recordEncoderResult,
  resolveAutoCodec,
  type CodecDecision,
} from '../lib/codec-selection';
import { StatsMeter, readOutboundVideo } from '../lib/rtc-stats';
import {
  SCREEN_QUALITIES,
  isScreenCodecChoice,
  isScreenQualityId,
  isSvcCodec,
  type ScreenCodec,
  type ScreenCodecChoice,
  type ScreenQualityId,
} from '../lib/screen-presets';
import { useVoice } from './voice';

type ScreenShareStatus = 'idle' | 'starting' | 'live';

const SETTINGS_KEY = 'screen.settings';
// Versão 2 (Fase Q): o codec passou a ter "auto" como padrão. Configurações salvas antes disso guardavam
// "h264" só porque era o padrão antigo, então o codec delas é descartado (a qualidade é mantida).
const SETTINGS_VERSION = 2;

interface StoredSettings {
  quality: ScreenQualityId;
  codec: ScreenCodecChoice;
}

function loadSettings(): StoredSettings {
  const fallback: StoredSettings = { quality: '1080p60', codec: 'auto' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return fallback;
    }
    const record = parsed as Record<string, unknown>;
    const current = record['version'] === SETTINGS_VERSION;
    return {
      quality: isScreenQualityId(record['quality']) ? record['quality'] : fallback.quality,
      codec: current && isScreenCodecChoice(record['codec']) ? record['codec'] : fallback.codec,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch {
    return;
  }
}

function describeCaptureError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return 'O compartilhamento foi cancelado ou negado';
    }
    if (err.name === 'NotFoundError' || err.name === 'NotReadableError') {
      return 'Não foi possível capturar a tela ou janela escolhida';
    }
  }
  return `Falha ao compartilhar a tela: ${errorMessage(err)}`;
}

let videoTrack: LocalVideoTrack | null = null;
let audioTrack: LocalAudioTrack | null = null;
let startSequence = 0;
let encoderTimer: number | null = null;

export function getLocalScreenTracks(): {
  video: LocalVideoTrack | null;
  audio: LocalAudioTrack | null;
} {
  return { video: videoTrack, audio: audioTrack };
}

export interface EncoderInfo {
  implementation: string;
  hardware: boolean;
}

interface ScreenShareState {
  status: ScreenShareStatus;
  quality: ScreenQualityId;
  // Escolha do usuário (pode ser "auto").
  codec: ScreenCodecChoice;
  // Codec efetivamente publicado e por quê (só enquanto ao vivo).
  activeCodec: ScreenCodec | null;
  decision: string | null;
  encoder: EncoderInfo | null;
  hasAudio: boolean;
  pickerOpen: boolean;
  error: string | null;
  openPicker(): void;
  closePicker(): void;
  setQuality(quality: ScreenQualityId): void;
  setCodec(codec: ScreenCodecChoice): void;
  start(sourceId: string, includeAudio: boolean): Promise<void>;
  stop(): Promise<void>;
  handleRoomClosed(): void;
  clearError(): void;
}

function stopEncoderWatch(): void {
  if (encoderTimer !== null) {
    window.clearInterval(encoderTimer);
    encoderTimer = null;
  }
}

function releaseTracks(): void {
  stopEncoderWatch();
  videoTrack?.stop();
  audioTrack?.stop();
  videoTrack = null;
  audioTrack = null;
}

async function unpublishAll(room: Room | null): Promise<void> {
  const tracks = [videoTrack, audioTrack].filter((track) => track !== null);
  if (room && room.state === ConnectionState.Connected) {
    for (const track of tracks) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    }
  }
  releaseTracks();
}

async function resolveCodec(choice: ScreenCodecChoice): Promise<CodecDecision> {
  if (choice !== 'auto') {
    return { codec: choice, hardware: false, source: 'padrão' };
  }
  return resolveAutoCodec();
}

export const useScreenShare = create<ScreenShareState>()((set, get) => {
  const settings = loadSettings();

  // Confere nas estatísticas qual codificador o Chromium realmente usou (a previsão pode errar) e grava o
  // resultado para a próxima escolha automática. Repete enquanto ao vivo: o WebRTC pode trocar para software no
  // meio da transmissão se o codificador da GPU falhar.
  const watchEncoder = (track: LocalVideoTrack, codec: ScreenCodec): void => {
    stopEncoderWatch();
    const meter = new StatsMeter();
    const check = async () => {
      if (videoTrack !== track) {
        stopEncoderWatch();
        return;
      }
      const stats = await readOutboundVideo(track, meter).catch(() => null);
      // Só vale camada que codificou quadros desde a leitura anterior (msPerFrame calculado): com o dynacast
      // pausando tudo (ninguém assistindo) o nome do codificador pode estar velho ou "unknown".
      const top = stats?.layers.find(
        (layer) => layer.encoder !== null && layer.msPerFrame !== null,
      );
      if (!top?.encoder || top.powerEfficient === null || top.encoder === 'unknown') {
        return;
      }
      const hardware = top.powerEfficient;
      const current = get().encoder;
      if (current?.implementation !== top.encoder || current.hardware !== hardware) {
        set({ encoder: { implementation: top.encoder, hardware } });
      }
      await recordEncoderResult(codec, hardware, top.encoder);
    };
    encoderTimer = window.setInterval(() => void check(), 5_000);
  };

  return {
    status: 'idle',
    quality: settings.quality,
    codec: settings.codec,
    activeCodec: null,
    decision: null,
    encoder: null,
    hasAudio: false,
    pickerOpen: false,
    error: null,

    openPicker() {
      set({ pickerOpen: true, error: null });
    },

    closePicker() {
      set({ pickerOpen: false });
    },

    setQuality(quality) {
      set({ quality });
      saveSettings({ quality, codec: get().codec });
    },

    setCodec(codec) {
      set({ codec });
      saveSettings({ quality: get().quality, codec });
    },

    async start(sourceId, includeAudio) {
      const room = useVoice.getState().room;
      if (!room || room.state !== ConnectionState.Connected) {
        set({ error: 'Entre em um canal de voz para compartilhar a tela' });
        return;
      }
      if (get().status !== 'idle') {
        return;
      }
      // Número de sequência: se o usuário cancelar ou sair enquanto o início assíncrono ainda corre,
      // a conclusão atrasada percebe que ficou obsoleta e desfaz o que publicou.
      const sequence = ++startSequence;
      const preset = SCREEN_QUALITIES[get().quality];
      set({ status: 'starting', error: null });
      let stream: MediaStream | null = null;
      try {
        const decision = await resolveCodec(get().codec);
        const codec = decision.codec;
        // O processo principal guarda a escolha por poucos segundos; o getDisplayMedia logo abaixo é
        // atendido por ela (main/screen-capture.ts), sem o seletor nativo do Chromium.
        await window.desktop.selectScreenSource(sourceId, includeAudio);
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: preset.width, max: preset.width },
            height: { ideal: preset.height, max: preset.height },
            frameRate: { ideal: preset.fps, max: preset.fps },
          },
          // Áudio do sistema é música ou som de jogo: nenhum processamento de voz (eco, ruído, ganho), que
          // cortaria e achataria o som. Estéreo quando a placa entregar.
          audio: includeAudio
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: { ideal: 2 },
              }
            : false,
        });
        const capturedVideo = stream.getVideoTracks()[0];
        if (!capturedVideo) {
          throw new Error('Nenhuma trilha de vídeo capturada');
        }
        // 'motion' diz ao codificador para priorizar fluidez (60 fps) em vez de nitidez de texto,
        // adequado para jogos e vídeo, que é o uso principal.
        capturedVideo.contentHint = 'motion';

        const localVideo = new LocalVideoTrack(capturedVideo, undefined, true);
        localVideo.once(TrackEvent.Ended, () => {
          if (videoTrack === localVideo) {
            void get().stop();
          }
        });
        videoTrack = localVideo;
        // VP9/AV1 usam SVC (uma só codificação com camadas temporais L1T3); H.264/VP8 não têm SVC
        // utilizável, então enviam simulcast. Em ambos o SFU escolhe a camada por espectador.
        const layering: TrackPublishOptions = isSvcCodec(codec)
          ? { simulcast: false, scalabilityMode: 'L1T3' }
          : { simulcast: true, screenShareSimulcastLayers: preset.layers };
        await room.localParticipant.publishTrack(localVideo, {
          source: Track.Source.ScreenShare,
          name: 'screen',
          videoCodec: codec,
          screenShareEncoding: {
            maxBitrate: preset.maxBitrate,
            maxFramerate: preset.fps,
            priority: 'high',
          },
          // Em sobrecarga (CPU ou rede do emissor) o WebRTC derruba o fps, nunca a resolução: quem assiste a
          // um jogo ou vídeo prefere a imagem nítida um pouco menos fluida a uma imagem borrada (decisão da Fase Q).
          degradationPreference: 'maintain-resolution',
          ...layering,
        });

        const capturedAudio = stream.getAudioTracks()[0];
        if (capturedAudio) {
          const localAudio = new LocalAudioTrack(capturedAudio, undefined, true);
          audioTrack = localAudio;
          await room.localParticipant.publishTrack(localAudio, {
            source: Track.Source.ScreenShareAudio,
            name: 'screen-audio',
            // Áudio do stream é música/jogo: estéreo de alta qualidade, sem DTX (que cortaria
            // trechos silenciosos) e sem RED (redundância dobraria a banda sem ganho aqui).
            audioPreset: AudioPresets.musicHighQualityStereo,
            dtx: false,
            red: false,
            forceStereo: true,
          });
        }

        if (sequence !== startSequence || room.state !== ConnectionState.Connected) {
          await unpublishAll(room);
          return;
        }
        set({
          status: 'live',
          activeCodec: codec,
          decision: get().codec === 'auto' ? describeDecision(decision) : 'escolhido manualmente',
          encoder: null,
          hasAudio: capturedAudio !== undefined,
          pickerOpen: false,
        });
        watchEncoder(localVideo, codec);
      } catch (err) {
        await unpublishAll(room);
        stream?.getTracks().forEach((track) => track.stop());
        if (sequence === startSequence) {
          set({ status: 'idle', hasAudio: false, error: describeCaptureError(err) });
        }
      }
    },

    async stop() {
      startSequence++;
      await unpublishAll(useVoice.getState().room);
      set({ status: 'idle', hasAudio: false, activeCodec: null, decision: null, encoder: null });
    },

    handleRoomClosed() {
      startSequence++;
      releaseTracks();
      set({
        status: 'idle',
        hasAudio: false,
        pickerOpen: false,
        activeCodec: null,
        decision: null,
        encoder: null,
      });
    },

    clearError() {
      set({ error: null });
    },
  };
});
