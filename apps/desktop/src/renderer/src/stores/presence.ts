import { create } from 'zustand';
import { presenceResponseSchema, type PresenceParticipant } from '@livekit-app/shared';
import { errorMessage, request } from '../lib/api';

interface PresenceState {
  byChannel: Record<string, PresenceParticipant[]>;
  error: string | null;
  refresh(): Promise<void>;
  reset(): void;
}

export const usePresence = create<PresenceState>()((set) => ({
  byChannel: {},
  error: null,

  async refresh() {
    try {
      const { channels } = await request('/api/presence', { schema: presenceResponseSchema });
      const byChannel: Record<string, PresenceParticipant[]> = {};
      for (const channel of channels) {
        byChannel[channel.channelId] = channel.participants;
      }
      set({ byChannel, error: null });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  reset() {
    set({ byChannel: {}, error: null });
  },
}));
