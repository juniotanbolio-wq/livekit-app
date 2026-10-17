import { create } from 'zustand';
import { ConnectionState, type Room } from 'livekit-client';
import { liveKitTokenResponseSchema } from '@livekit-app/shared';
import { errorMessage, request } from '../lib/api';
import {
  applySpectatorSubscriptions,
  listScreenShares,
  type StreamInfo,
} from '../voice/spectator-subscriptions';
import { useVoice } from './voice';

export type SpectatorConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type WatchMode = 'voice' | 'spectator';

const VOLUME_KEY = 'watch.volume';

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) {
      return 0.8;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
  } catch {
    return 0.8;
  }
}

function saveVolume(value: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    return;
  }
}

function voiceCovers(channelId: string | null): boolean {
  if (!channelId) {
    return false;
  }
  const voice = useVoice.getState();
  return voice.channelId === channelId && voice.connection !== 'idle';
}

export function resolveWatchMode(watchedChannelId: string | null): WatchMode {
  return voiceCovers(watchedChannelId) ? 'voice' : 'spectator';
}

interface WatchState {
  room: Room | null;
  watchedChannelId: string | null;
  selectedIdentity: string | null;
  streams: StreamInfo[];
  audioEnabled: boolean;
  volume: number;
  playerVisible: boolean;
  spectatorChannelId: string | null;
  spectatorConnection: SpectatorConnection;
  error: string | null;
  attachRoom(room: Room | null): void;
  watch(channelId: string, identity?: string): void;
  stop(): void;
  selectStream(identity: string): void;
  setAudioEnabled(enabled: boolean): void;
  setVolume(volume: number): void;
  setPlayerVisible(visible: boolean): void;
  reconcile(): Promise<void>;
  refreshStreams(): void;
  syncConnectionState(state: ConnectionState): void;
  handleDisconnected(): void;
}

let reconcileSequence = 0;

export const useWatch = create<WatchState>()((set, get) => {
  const activeRoom = (): Room | null => {
    const { watchedChannelId, room, spectatorConnection } = get();
    if (!watchedChannelId) {
      return null;
    }
    if (voiceCovers(watchedChannelId)) {
      return useVoice.getState().room;
    }
    return spectatorConnection === 'idle' ? null : room;
  };

  const applySubscriptions = (): void => {
    const { room, selectedIdentity, audioEnabled, playerVisible, watchedChannelId } = get();
    if (!room || room.state !== ConnectionState.Connected) {
      return;
    }
    applySpectatorSubscriptions(room, {
      selectedIdentity:
        watchedChannelId && !voiceCovers(watchedChannelId) ? selectedIdentity : null,
      audioEnabled,
      videoEnabled: playerVisible,
    });
  };

  return {
    room: null,
    watchedChannelId: null,
    selectedIdentity: null,
    streams: [],
    audioEnabled: false,
    volume: loadVolume(),
    playerVisible: false,
    spectatorChannelId: null,
    spectatorConnection: 'idle',
    error: null,

    attachRoom(room) {
      set({ room });
    },

    watch(channelId, identity) {
      const current = get();
      set({
        watchedChannelId: channelId,
        selectedIdentity:
          identity ?? (current.watchedChannelId === channelId ? current.selectedIdentity : null),
        streams: current.watchedChannelId === channelId ? current.streams : [],
        audioEnabled: current.watchedChannelId === channelId ? current.audioEnabled : false,
        error: null,
      });
      void get().reconcile();
    },

    stop() {
      set({
        watchedChannelId: null,
        selectedIdentity: null,
        streams: [],
        audioEnabled: false,
        error: null,
      });
      void get().reconcile();
    },

    selectStream(identity) {
      set({ selectedIdentity: identity });
      applySubscriptions();
    },

    setAudioEnabled(enabled) {
      set({ audioEnabled: enabled });
      applySubscriptions();
    },

    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      set({ volume: clamped });
      saveVolume(clamped);
    },

    setPlayerVisible(visible) {
      set({ playerVisible: visible });
      applySubscriptions();
    },

    async reconcile() {
      const { room, watchedChannelId, spectatorChannelId, spectatorConnection } = get();
      if (!room) {
        return;
      }
      const target = watchedChannelId && !voiceCovers(watchedChannelId) ? watchedChannelId : null;
      if (target === spectatorChannelId && (target === null || spectatorConnection !== 'idle')) {
        get().refreshStreams();
        return;
      }
      const sequence = ++reconcileSequence;
      set({ spectatorChannelId: target, spectatorConnection: target ? 'connecting' : 'idle' });
      if (room.state !== ConnectionState.Disconnected) {
        await room.disconnect();
      }
      if (sequence !== reconcileSequence) {
        return;
      }
      if (!target) {
        get().refreshStreams();
        return;
      }
      try {
        const { token, url } = await request('/api/livekit/token', {
          method: 'POST',
          body: { channelId: target, role: 'spectator' },
          schema: liveKitTokenResponseSchema,
        });
        if (sequence !== reconcileSequence) {
          return;
        }
        await room.connect(url, token, { autoSubscribe: false });
        if (sequence !== reconcileSequence) {
          await room.disconnect();
          return;
        }
        set({ spectatorConnection: 'connected', error: null });
        const output = useVoice.getState().devices.audiooutput;
        if (output) {
          await room.switchActiveDevice('audiooutput', output).catch(() => false);
        }
        get().refreshStreams();
      } catch (err) {
        if (sequence !== reconcileSequence) {
          return;
        }
        set({
          spectatorChannelId: null,
          spectatorConnection: 'idle',
          error: `Não foi possível assistir à transmissão: ${errorMessage(err)}`,
        });
        if (room.state !== ConnectionState.Disconnected) {
          await room.disconnect();
        }
      }
    },

    refreshStreams() {
      const roomInUse = activeRoom();
      const streams =
        roomInUse && roomInUse.state === ConnectionState.Connected
          ? listScreenShares(roomInUse)
          : [];
      const { selectedIdentity } = get();
      const selected =
        selectedIdentity && streams.some((stream) => stream.identity === selectedIdentity)
          ? selectedIdentity
          : (streams[0]?.identity ?? selectedIdentity);
      set({ streams, selectedIdentity: selected });
      applySubscriptions();
    },

    syncConnectionState(state) {
      if (get().spectatorChannelId === null) {
        return;
      }
      switch (state) {
        case ConnectionState.Connected:
          set({ spectatorConnection: 'connected' });
          get().refreshStreams();
          break;
        case ConnectionState.Reconnecting:
        case ConnectionState.SignalReconnecting:
          set({ spectatorConnection: 'reconnecting' });
          break;
        default:
          break;
      }
    },

    handleDisconnected() {
      const { spectatorConnection } = get();
      if (spectatorConnection === 'idle' || spectatorConnection === 'connecting') {
        return;
      }
      set({
        spectatorChannelId: null,
        spectatorConnection: 'idle',
        streams: [],
        error: 'A conexão com a transmissão foi perdida.',
      });
    },
  };
});
