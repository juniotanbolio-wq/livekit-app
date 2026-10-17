import { create } from 'zustand';
import { ConnectionState, MediaDeviceFailure, type Room } from 'livekit-client';
import { createLiveKitToken, errorMessage } from '../lib/api';

export type DeviceKind = 'audioinput' | 'videoinput' | 'audiooutput';

export type VoiceConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting';

type DevicePreferences = Partial<Record<DeviceKind, string>>;

const DEVICES_KEY = 'voice.devices';

function loadDevices(): DevicePreferences {
  try {
    const raw = localStorage.getItem(DEVICES_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const result: DevicePreferences = {};
    for (const kind of ['audioinput', 'videoinput', 'audiooutput'] as const) {
      const value = (parsed as Record<string, unknown>)[kind];
      if (typeof value === 'string' && value.length > 0) {
        result[kind] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveDevices(devices: DevicePreferences): void {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
  } catch {
    return;
  }
}

function mediaErrorMessage(err: unknown, what: 'microfone' | 'câmera'): string {
  const failure = MediaDeviceFailure.getFailure(err);
  switch (failure) {
    case MediaDeviceFailure.PermissionDenied:
      return `Permissão de ${what} negada`;
    case MediaDeviceFailure.NotFound:
      return `Nenhum dispositivo de ${what} encontrado`;
    case MediaDeviceFailure.DeviceInUse:
      return `O dispositivo de ${what} está em uso por outro aplicativo`;
    default:
      return `Falha ao acessar ${what}: ${errorMessage(err)}`;
  }
}

interface VoiceState {
  room: Room | null;
  channelId: string | null;
  connection: VoiceConnection;
  micEnabled: boolean;
  cameraEnabled: boolean;
  deafened: boolean;
  micBeforeDeafen: boolean;
  devices: DevicePreferences;
  error: string | null;
  attachRoom(room: Room | null): void;
  join(channelId: string): Promise<void>;
  leave(): Promise<void>;
  toggleMic(): Promise<void>;
  toggleCamera(): Promise<void>;
  toggleDeafen(): Promise<void>;
  setDevice(kind: DeviceKind, deviceId: string): Promise<void>;
  syncConnectionState(state: ConnectionState): void;
  handleDisconnected(): void;
  setError(message: string | null): void;
}

let joinSequence = 0;

export const useVoice = create<VoiceState>()((set, get) => {
  const applyMic = async (enabled: boolean): Promise<void> => {
    const { room, devices } = get();
    if (!room || room.state !== ConnectionState.Connected) {
      return;
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(
        enabled,
        devices.audioinput ? { deviceId: devices.audioinput } : undefined,
      );
    } catch (err) {
      set({ micEnabled: false, error: mediaErrorMessage(err, 'microfone') });
    }
  };

  const applyCamera = async (enabled: boolean): Promise<void> => {
    const { room, devices } = get();
    if (!room || room.state !== ConnectionState.Connected) {
      return;
    }
    try {
      await room.localParticipant.setCameraEnabled(
        enabled,
        devices.videoinput ? { deviceId: devices.videoinput } : undefined,
      );
    } catch (err) {
      set({ cameraEnabled: false, error: mediaErrorMessage(err, 'câmera') });
    }
  };

  return {
    room: null,
    channelId: null,
    connection: 'idle',
    micEnabled: true,
    cameraEnabled: false,
    deafened: false,
    micBeforeDeafen: true,
    devices: loadDevices(),
    error: null,

    attachRoom(room) {
      set({ room });
    },

    async join(channelId) {
      const { room, channelId: currentChannel, connection } = get();
      if (!room) {
        return;
      }
      if (currentChannel === channelId && connection !== 'idle') {
        return;
      }
      const sequence = ++joinSequence;
      set({ channelId, connection: 'connecting', error: null });
      if (room.state !== ConnectionState.Disconnected) {
        await room.disconnect();
      }
      try {
        // A URL do LiveKit é a que o backend devolve junto com o token.
        const { token, url } = await createLiveKitToken(channelId, 'voice');
        if (sequence !== joinSequence) {
          return;
        }
        await room.connect(url, token, { autoSubscribe: true });
        if (sequence !== joinSequence) {
          await room.disconnect();
          return;
        }
        set({ connection: 'connected' });
        const { devices, micEnabled, deafened, cameraEnabled } = get();
        if (devices.audiooutput) {
          await room.switchActiveDevice('audiooutput', devices.audiooutput).catch(() => false);
        }
        await applyMic(micEnabled && !deafened);
        if (cameraEnabled) {
          await applyCamera(true);
        }
      } catch (err) {
        if (sequence !== joinSequence) {
          return;
        }
        set({
          channelId: null,
          connection: 'idle',
          error: `Não foi possível entrar no canal de voz: ${errorMessage(err)}`,
        });
        if (room.state !== ConnectionState.Disconnected) {
          await room.disconnect();
        }
      }
    },

    async leave() {
      joinSequence++;
      const { room } = get();
      set({ channelId: null, connection: 'idle' });
      if (room && room.state !== ConnectionState.Disconnected) {
        await room.disconnect();
      }
    },

    async toggleMic() {
      const { micEnabled, deafened } = get();
      if (deafened) {
        set({ deafened: false, micEnabled: true });
        await applyMic(true);
        return;
      }
      const next = !micEnabled;
      set({ micEnabled: next });
      await applyMic(next);
    },

    async toggleCamera() {
      const next = !get().cameraEnabled;
      set({ cameraEnabled: next });
      await applyCamera(next);
    },

    async toggleDeafen() {
      const { deafened, micEnabled, micBeforeDeafen } = get();
      if (deafened) {
        set({ deafened: false, micEnabled: micBeforeDeafen });
        await applyMic(micBeforeDeafen);
        return;
      }
      set({ deafened: true, micBeforeDeafen: micEnabled, micEnabled: false });
      await applyMic(false);
    },

    async setDevice(kind, deviceId) {
      const devices = { ...get().devices, [kind]: deviceId };
      set({ devices });
      saveDevices(devices);
      const { room } = get();
      if (!room) {
        return;
      }
      try {
        await room.switchActiveDevice(kind, deviceId);
      } catch (err) {
        set({ error: `Falha ao trocar dispositivo: ${errorMessage(err)}` });
      }
    },

    syncConnectionState(state) {
      if (get().channelId === null) {
        return;
      }
      switch (state) {
        case ConnectionState.Connected:
          set({ connection: 'connected' });
          break;
        case ConnectionState.Reconnecting:
        case ConnectionState.SignalReconnecting:
          set({ connection: 'reconnecting' });
          break;
        case ConnectionState.Connecting:
          set({ connection: 'connecting' });
          break;
        default:
          break;
      }
    },

    handleDisconnected() {
      const { connection } = get();
      if (connection === 'connecting' || connection === 'idle') {
        return;
      }
      set({
        channelId: null,
        connection: 'idle',
        error: 'A conexão de voz foi perdida. Entre no canal novamente.',
      });
    },

    setError(message) {
      set({ error: message });
    },
  };
});
