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

function createSpectatorRoom(): Room {
  return new Room({
    adaptiveStream: false,
    dynacast: false,
  });
}

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
