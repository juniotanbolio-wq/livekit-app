import { create } from 'zustand';
import type { ChannelPresence, PresenceParticipant } from '../lib/api';
import type { PresenceEvent } from '../lib/realtime';

// Quem está em cada canal de voz e quem está transmitindo, mantido pelo WebSocket: o snapshot substitui
// tudo e cada evento (já conferido o seq em lib/realtime.ts) aplica uma mudança.
interface PresenceState {
  byChannel: Record<string, PresenceParticipant[]>;
  applySnapshot(channels: ChannelPresence[]): void;
  applyEvent(event: PresenceEvent): void;
  reset(): void;
}

function byName(a: PresenceParticipant, b: PresenceParticipant): number {
  return a.username.localeCompare(b.username, 'pt-BR');
}

function setSharing(
  list: PresenceParticipant[],
  userId: string,
  isScreenSharing: boolean,
): PresenceParticipant[] {
  return list.map((item) => (item.userId === userId ? { ...item, isScreenSharing } : item));
}

export const usePresence = create<PresenceState>()((set) => ({
  byChannel: {},

  applySnapshot(channels) {
    const byChannel: Record<string, PresenceParticipant[]> = {};
    for (const channel of channels) {
      byChannel[channel.channelId] = [...channel.participants].sort(byName);
    }
    set({ byChannel });
  },

  applyEvent(event) {
    set((state) => {
      const current = state.byChannel[event.channelId] ?? [];
      let next: PresenceParticipant[];
      switch (event.type) {
        case 'participant_joined':
          // Pode chegar já com isScreenSharing=true (descoberto pela reconciliação do servidor);
          // equivale a participant_joined + stream_started.
          next = [
            ...current.filter((item) => item.userId !== event.participant.userId),
            event.participant,
          ].sort(byName);
          break;
        case 'participant_left':
          // Sair do canal também encerra a transmissão: não vem stream_stopped antes.
          next = current.filter((item) => item.userId !== event.userId);
          break;
        case 'stream_started':
          next = setSharing(current, event.userId, true);
          break;
        case 'stream_stopped':
          next = setSharing(current, event.userId, false);
          break;
      }
      return { byChannel: { ...state.byChannel, [event.channelId]: next } };
    });
  },

  reset() {
    set({ byChannel: {} });
  },
}));
