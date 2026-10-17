import { useEffect, useState, type ReactNode } from 'react';
import { AudioTrack, isTrackReference, useTracks } from '@livekit/components-react';
import {
  Room,
  RoomEvent,
  Track,
  type ConnectionState,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useSession } from '../stores/session';
import { useVoice } from '../stores/voice';
import { useWatch } from '../stores/watch';
import { isAllowedSpectatorSubscription } from './spectator-subscriptions';

// Segunda conexão (identidade `<id>#spectator`, hidden, sem publicar), usada só para assistir
// telas. As assinaturas são feitas faixa a faixa (stores/watch.ts): nunca assinamos microfone
// ou câmera do canal assistido.
function createSpectatorRoom(): Room {
  return new Room({
    // adaptiveStream desligado: ele reduz a qualidade conforme o tamanho do elemento <video>,
    // e queremos sempre a camada mais alta da tela (1080p60), mesmo com a janela pequena.
    adaptiveStream: false,
    dynacast: false,
  });
}

// Áudio do stream (loopback do transmissor): opcional, só da transmissão selecionada e
// silenciado junto com o "ensurdecer" da voz.
function SpectatorAudio({ room }: { room: Room }) {
  const selectedIdentity = useWatch((state) => state.selectedIdentity);
  const audioEnabled = useWatch((state) => state.audioEnabled);
  const volume = useWatch((state) => state.volume);
  const deafened = useVoice((state) => state.deafened);
  const tracks = useTracks([Track.Source.ScreenShareAudio], { room, onlySubscribed: true });

  if (!audioEnabled) {
    return null;
  }
  const trackRef = tracks.find(
    (item) => item.participant.identity === selectedIdentity && isTrackReference(item),
  );
  if (!trackRef || !isTrackReference(trackRef)) {
    return null;
  }
  return <AudioTrack trackRef={trackRef} volume={volume} muted={deafened} />;
}

export function SpectatorProvider({ children }: { children: ReactNode }) {
  const [room] = useState(createSpectatorRoom);
  const authenticated = useSession((state) => state.status === 'authenticated');

  useEffect(() => {
    useWatch.getState().attachRoom(room);

    const refresh = () => {
      useWatch.getState().refreshStreams();
    };
    const onConnectionState = (state: ConnectionState) => {
      useWatch.getState().syncConnectionState(state);
    };
    const onDisconnected = () => {
      useWatch.getState().handleDisconnected();
    };
    const onTrackSubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      // Defesa em profundidade: se o SFU entregar uma faixa fora da lista permitida (por bug ou
      // corrida entre assinaturas), cancelamos na hora em vez de reproduzir.
      const { selectedIdentity } = useWatch.getState();
      if (
        !isAllowedSpectatorSubscription(publication.source, participant.identity, selectedIdentity)
      ) {
        console.warn(
          `Espectador: assinatura indevida de ${publication.source} de ${participant.identity}, cancelando`,
        );
        publication.setSubscribed(false);
      }
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnectionState);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.TrackPublished, refresh);
    room.on(RoomEvent.TrackUnpublished, refresh);
    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);

    // Reconcilia o espectador quando o usuário entra, sai ou troca de canal de voz, e acompanha
    // o dispositivo de saída de áudio escolhido.
    const unsubscribeVoice = useVoice.subscribe((state, previous) => {
      if (state.channelId !== previous.channelId || state.connection !== previous.connection) {
        void useWatch.getState().reconcile();
      }
      const output = state.devices.audiooutput;
      if (output && output !== previous.devices.audiooutput) {
        void room.switchActiveDevice('audiooutput', output).catch(() => false);
      }
    });

    return () => {
      unsubscribeVoice();
      room.off(RoomEvent.ConnectionStateChanged, onConnectionState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackPublished, refresh);
      room.off(RoomEvent.TrackUnpublished, refresh);
      room.off(RoomEvent.ParticipantConnected, refresh);
      room.off(RoomEvent.ParticipantDisconnected, refresh);
      useWatch.getState().attachRoom(null);
      void room.disconnect();
    };
  }, [room]);

  useEffect(() => {
    if (!authenticated) {
      useWatch.getState().stop();
    }
  }, [authenticated]);

  return (
    <>
      <SpectatorAudio room={room} />
      {children}
    </>
  );
}
