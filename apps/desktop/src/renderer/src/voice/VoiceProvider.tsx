import { useEffect, useState, type ReactNode } from 'react';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import type { ConnectionState, LocalTrackPublication } from 'livekit-client';
import { MediaDeviceFailure, Room, RoomEvent, Track } from 'livekit-client';
import { useScreenShare } from '../stores/screen-share';
import { useSession } from '../stores/session';
import { useVoice } from '../stores/voice';
import { useWatch } from '../stores/watch';

function createRoom(): Room {
  const devices = useVoice.getState().devices;
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(devices.audioinput ? { deviceId: devices.audioinput } : {}),
    },
    videoCaptureDefaults: devices.videoinput ? { deviceId: devices.videoinput } : {},
    audioOutput: devices.audiooutput ? { deviceId: devices.audiooutput } : {},
  });
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [room] = useState(createRoom);
  const deafened = useVoice((state) => state.deafened);
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
    const onLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (
        publication.source === Track.Source.ScreenShare &&
        useScreenShare.getState().status === 'live'
      ) {
        void useScreenShare.getState().stop();
      }
    };
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

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.off(RoomEvent.TrackPublished, onRemoteTracksChanged);
      room.off(RoomEvent.TrackUnpublished, onRemoteTracksChanged);
      room.off(RoomEvent.ParticipantConnected, onRemoteTracksChanged);
      room.off(RoomEvent.ParticipantDisconnected, onRemoteTracksChanged);
      room.off(RoomEvent.Connected, onRemoteTracksChanged);
      useVoice.getState().attachRoom(null);
      void room.disconnect();
    };
  }, [room]);

  useEffect(() => {
    if (!authenticated) {
      void useScreenShare.getState().stop();
      void useVoice.getState().leave();
    }
  }, [authenticated]);

  return (
    <RoomContext.Provider value={room}>
      <RoomAudioRenderer room={room} muted={deafened} />
      {children}
    </RoomContext.Provider>
  );
}
