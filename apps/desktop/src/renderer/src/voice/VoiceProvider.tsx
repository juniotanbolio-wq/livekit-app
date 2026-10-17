import { useEffect, useState, type ReactNode } from 'react';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import type { ConnectionState } from 'livekit-client';
import { MediaDeviceFailure, Room, RoomEvent } from 'livekit-client';
import { useSession } from '../stores/session';
import { useVoice } from '../stores/voice';

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

    room.on(RoomEvent.ConnectionStateChanged, onConnectionState);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      useVoice.getState().attachRoom(null);
      void room.disconnect();
    };
  }, [room]);

  useEffect(() => {
    if (!authenticated) {
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
