import { useEffect, useState, type ReactNode } from 'react';
import { RoomContext } from '@livekit/components-react';
import type { ConnectionState, LocalTrackPublication } from 'livekit-client';
import { MediaDeviceFailure, Room, RoomEvent, Track } from 'livekit-client';
import {
  VOICE_PUBLISH_OPTIONS,
  captureOptionsFor,
  currentAudioSettings,
  useAudioSettings,
} from '../stores/audio-settings';
import { useScreenShare } from '../stores/screen-share';
import { useSession } from '../stores/session';
import { useVoice } from '../stores/voice';
import { useWatch } from '../stores/watch';
import { MicrophoneAudio, StreamAudio } from './StreamAudio';

// Sala da conexão de voz do usuário (microfone, câmera e publicação de tela).
// O Modo Espectador usa uma segunda Room separada (SpectatorProvider); misturar as duas
// faria o espectador assinar microfones e câmeras do canal, o que é proibido.
function createRoom(): Room {
  const devices = useVoice.getState().devices;
  return new Room({
    // adaptiveStream desligado (Fase Q): ele escolhe a camada pelo tamanho do <video> e, no livekit-client, vale
    // para a sala inteira e passa por cima de setVideoQuality. Com ele, quem assistia pela voz recebia 720p na
    // janela padrão. As camadas agora são pedidas explicitamente (voice/subscriptions.ts): tela na mais alta,
    // câmera na média.
    adaptiveStream: false,
    // dynacast: o SFU avisa quais camadas alguém assiste e o emissor para de codificar e enviar as outras. Sem
    // ninguém assistindo a tela, o upload dela vai a ~0 (medido em docs/medicoes.md).
    dynacast: true,
    // Vale para o microfone; o áudio da tela sobrescreve (estéreo, sem DTX nem RED) em stores/screen-share.ts.
    publishDefaults: VOICE_PUBLISH_OPTIONS,
    // Processamento de voz do navegador conforme o modo escolhido (eco e ganho sempre; ruído nativo só no
    // "Padrão"). O microfone é criado com estas mesmas opções em stores/voice.ts.
    audioCaptureDefaults: captureOptionsFor(currentAudioSettings(), devices.audioinput),
    videoCaptureDefaults: devices.videoinput ? { deviceId: devices.videoinput } : {},
    audioOutput: devices.audiooutput ? { deviceId: devices.audiooutput } : {},
  });
}

// Mantém uma única Room durante toda a vida do app e a expõe via contexto. A entrada e saída
// de canais é feita pelo store de voz (stores/voice.ts); aqui só ligamos eventos da Room aos stores.
export function VoiceProvider({ children }: { children: ReactNode }) {
  const [room] = useState(createRoom);
  const authenticated = useSession((state) => state.status === 'authenticated');

  useEffect(() => {
    const voice = useVoice.getState();
    voice.attachRoom(room);

    const onConnectionState = (state: ConnectionState) => {
      useVoice.getState().syncConnectionState(state);
    };
    const onDisconnected = () => {
      useScreenShare.getState().handleRoomClosed();
      useVoice.getState().handleDisconnected();
    };
    const onMediaDevicesError = (error: Error) => {
      const failure = MediaDeviceFailure.getFailure(error);
      useVoice
        .getState()
        .setError(
          failure === MediaDeviceFailure.PermissionDenied
            ? 'Permissão de mídia negada'
            : `Erro de dispositivo de mídia: ${error.message}`,
        );
    };
    // Se a faixa de tela some por fora do nosso fluxo (ex.: o usuário clica em "Parar
    // compartilhamento" na barra do Windows), o estado do store precisa acompanhar.
    const onLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (
        publication.source === Track.Source.ScreenShare &&
        useScreenShare.getState().status === 'live'
      ) {
        void useScreenShare.getState().stop();
      }
    };
    // Com autoSubscribe desligado, toda trilha nova (microfone de quem entrou, tela que começou) passa pela
    // regra de assinaturas; refreshStreams também atualiza a lista de transmissões (badge AO VIVO).
    const onRemoteTracksChanged = () => {
      useWatch.getState().refreshStreams();
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnectionState);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    room.on(RoomEvent.TrackPublished, onRemoteTracksChanged);
    room.on(RoomEvent.TrackUnpublished, onRemoteTracksChanged);
    room.on(RoomEvent.ParticipantConnected, onRemoteTracksChanged);
    room.on(RoomEvent.ParticipantDisconnected, onRemoteTracksChanged);
    room.on(RoomEvent.Connected, onRemoteTracksChanged);
    room.on(RoomEvent.Reconnected, onRemoteTracksChanged);

    // Configurações de áudio mudam com a pessoa já na voz: aplica no microfone na hora.
    const unsubscribeAudio = useAudioSettings.subscribe((next, previous) => {
      if (
        next.suppression !== previous.suppression ||
        next.gateEnabled !== previous.gateEnabled ||
        next.gateThresholdDb !== previous.gateThresholdDb
      ) {
        void useVoice.getState().applyAudioSettings(next, previous);
      }
    });

    return () => {
      unsubscribeAudio();
      room.off(RoomEvent.ConnectionStateChanged, onConnectionState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.off(RoomEvent.TrackPublished, onRemoteTracksChanged);
      room.off(RoomEvent.TrackUnpublished, onRemoteTracksChanged);
      room.off(RoomEvent.ParticipantConnected, onRemoteTracksChanged);
      room.off(RoomEvent.ParticipantDisconnected, onRemoteTracksChanged);
      room.off(RoomEvent.Connected, onRemoteTracksChanged);
      room.off(RoomEvent.Reconnected, onRemoteTracksChanged);
      useVoice.getState().attachRoom(null);
      void room.disconnect();
    };
  }, [room]);

  // Logout ou sessão expirada: encerra tela e voz para não deixar mídia aberta sem usuário logado.
  useEffect(() => {
    if (!authenticated) {
      void useScreenShare.getState().stop();
      void useVoice.getState().leave();
    }
  }, [authenticated]);

  return (
    <RoomContext.Provider value={room}>
      <MicrophoneAudio room={room} />
      <StreamAudio room={room} />
      {children}
    </RoomContext.Provider>
  );
}
