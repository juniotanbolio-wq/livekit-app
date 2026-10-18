import { create } from 'zustand';
import { ConnectionState, type Room } from 'livekit-client';
import { createLiveKitToken, errorMessage } from '../lib/api';
import {
  applySpectatorSubscriptions,
  applyVoiceSubscriptions,
  listScreenShares,
  type StreamInfo,
} from '../voice/subscriptions';
import { useVoice } from './voice';

// "Assistir" uma transmissão. Se a pessoa está na voz do mesmo canal, a tela chega pela própria conexão de voz
// (modo 'voice'); senão, por uma segunda conexão de espectador, oculta e só com a tela (modo 'spectator').
// Nos dois casos a assinatura é sob demanda: só existe enquanto watchedChannelId aponta para o canal.
export type SpectatorConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type WatchMode = 'voice' | 'spectator';

const VOLUME_KEY = 'watch.volume';
const AUDIO_KEY = 'watch.audio';

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

// Áudio da transmissão começa ligado ao assistir (como no Discord); se a pessoa desligar, a escolha vale para as
// próximas vezes.
function loadAudioPreference(): boolean {
  try {
    return localStorage.getItem(AUDIO_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveAudioPreference(enabled: boolean): void {
  try {
    localStorage.setItem(AUDIO_KEY, enabled ? 'on' : 'off');
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
  applySubscriptions(): void;
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

  return {
    room: null,
    watchedChannelId: null,
    selectedIdentity: null,
    streams: [],
    audioEnabled: loadAudioPreference(),
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
      const sameChannel = current.watchedChannelId === channelId;
      set({
        watchedChannelId: channelId,
        selectedIdentity: identity ?? (sameChannel ? current.selectedIdentity : null),
        streams: sameChannel ? current.streams : [],
        audioEnabled: sameChannel ? current.audioEnabled : loadAudioPreference(),
        error: null,
      });
      void get().reconcile();
    },

    stop() {
      set({
        watchedChannelId: null,
        selectedIdentity: null,
        streams: [],
        error: null,
      });
      // Desassina a tela já, nas duas salas; a reconciliação depois só fecha o espectador, se houver.
      get().applySubscriptions();
      void get().reconcile();
    },

    selectStream(identity) {
      set({ selectedIdentity: identity });
      get().applySubscriptions();
    },

    setAudioEnabled(enabled) {
      set({ audioEnabled: enabled });
      saveAudioPreference(enabled);
      get().applySubscriptions();
    },

    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      set({ volume: clamped });
      saveVolume(clamped);
    },

    setPlayerVisible(visible) {
      set({ playerVisible: visible });
      get().applySubscriptions();
    },

    // Faz as duas salas refletirem o estado: a de voz sempre (microfones e câmeras dependem dela também) e a do
    // espectador só quando é ela que cobre o canal assistido.
    applySubscriptions() {
      const { room, selectedIdentity, audioEnabled, playerVisible, watchedChannelId } = get();
      const byVoice = voiceCovers(watchedChannelId);
      const voiceRoom = useVoice.getState().room;
      if (voiceRoom && voiceRoom.state === ConnectionState.Connected) {
        applyVoiceSubscriptions(voiceRoom, {
          selectedIdentity: byVoice ? selectedIdentity : null,
          audioEnabled,
          videoEnabled: playerVisible,
        });
      }
      if (room && room.state === ConnectionState.Connected) {
        applySpectatorSubscriptions(room, {
          selectedIdentity: watchedChannelId && !byVoice ? selectedIdentity : null,
          audioEnabled,
          videoEnabled: playerVisible,
        });
      }
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
        const { token, url } = await createLiveKitToken(target, 'spectator');
        if (sequence !== reconcileSequence) {
          return;
        }
        // autoSubscribe desligado: as assinaturas são feitas trilha a trilha (voice/subscriptions.ts).
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
      get().applySubscriptions();
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
