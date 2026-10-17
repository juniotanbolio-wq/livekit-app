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
  SCREEN_QUALITIES,
  isScreenCodec,
  isScreenQualityId,
  isSvcCodec,
  type ScreenCodec,
  type ScreenQualityId,
} from '../lib/screen-presets';
import { useVoice } from './voice';

type ScreenShareStatus = 'idle' | 'starting' | 'live';

const SETTINGS_KEY = 'screen.settings';

interface StoredSettings {
  quality: ScreenQualityId;
  codec: ScreenCodec;
}

function loadSettings(): StoredSettings {
  const fallback: StoredSettings = { quality: '1080p60', codec: 'h264' };
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
    return {
      quality: isScreenQualityId(record['quality']) ? record['quality'] : fallback.quality,
      codec: isScreenCodec(record['codec']) ? record['codec'] : fallback.codec,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

export function getLocalScreenTracks(): {
  video: LocalVideoTrack | null;
  audio: LocalAudioTrack | null;
} {
  return { video: videoTrack, audio: audioTrack };
}

interface ScreenShareState {
  status: ScreenShareStatus;
  quality: ScreenQualityId;
  codec: ScreenCodec;
  hasAudio: boolean;
  pickerOpen: boolean;
  error: string | null;
  openPicker(): void;
  closePicker(): void;
  setQuality(quality: ScreenQualityId): void;
  setCodec(codec: ScreenCodec): void;
  start(sourceId: string, includeAudio: boolean): Promise<void>;
  stop(): Promise<void>;
  handleRoomClosed(): void;
  clearError(): void;
}

function releaseTracks(): void {
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

export const useScreenShare = create<ScreenShareState>()((set, get) => {
  const settings = loadSettings();

  return {
    status: 'idle',
    quality: settings.quality,
    codec: settings.codec,
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
      const sequence = ++startSequence;
      const preset = SCREEN_QUALITIES[get().quality];
      const codec = get().codec;
      set({ status: 'starting', error: null });
      let stream: MediaStream | null = null;
      try {
        await window.desktop.selectScreenSource(sourceId, includeAudio);
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: preset.width, max: preset.width },
            height: { ideal: preset.height, max: preset.height },
            frameRate: { ideal: preset.fps, max: preset.fps },
          },
          audio: includeAudio,
        });
        const capturedVideo = stream.getVideoTracks()[0];
        if (!capturedVideo) {
          throw new Error('Nenhuma trilha de vídeo capturada');
        }
        capturedVideo.contentHint = 'motion';

        const localVideo = new LocalVideoTrack(capturedVideo, undefined, true);
        localVideo.once(TrackEvent.Ended, () => {
          if (videoTrack === localVideo) {
            void get().stop();
          }
        });
        videoTrack = localVideo;
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
          degradationPreference: 'maintain-framerate',
          ...layering,
        });

        const capturedAudio = stream.getAudioTracks()[0];
        if (capturedAudio) {
          const localAudio = new LocalAudioTrack(capturedAudio, undefined, true);
          audioTrack = localAudio;
          await room.localParticipant.publishTrack(localAudio, {
            source: Track.Source.ScreenShareAudio,
            name: 'screen-audio',
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
        set({ status: 'live', hasAudio: capturedAudio !== undefined, pickerOpen: false });
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
      set({ status: 'idle', hasAudio: false });
    },

    handleRoomClosed() {
      startSequence++;
      releaseTracks();
      set({ status: 'idle', hasAudio: false, pickerOpen: false });
    },

    clearError() {
      set({ error: null });
    },
  };
});
