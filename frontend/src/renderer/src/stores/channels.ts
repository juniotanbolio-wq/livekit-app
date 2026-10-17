import { create } from 'zustand';
import { channelListResponseSchema, type Channel } from '../../../api/types';
import { errorMessage, request } from '../lib/api';

interface ChannelsState {
  channels: Channel[];
  loading: boolean;
  error: string | null;
  viewedChannelId: string | null;
  load(): Promise<void>;
  setChannels(channels: Channel[]): void;
  view(channelId: string): void;
  reset(): void;
}

function defaultViewed(channels: Channel[], current: string | null): string | null {
  if (current && channels.some((channel) => channel.id === current)) {
    return current;
  }
  return channels[0]?.id ?? null;
}

export const useChannels = create<ChannelsState>()((set, get) => ({
  channels: [],
  loading: false,
  error: null,
  viewedChannelId: null,

  async load() {
    set({ loading: true, error: null });
    try {
      const { channels } = await request('/api/channels', { schema: channelListResponseSchema });
      get().setChannels(channels);
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  setChannels(channels) {
    const sorted = [...channels].sort((a, b) => a.position - b.position);
    set({
      channels: sorted,
      error: null,
      viewedChannelId: defaultViewed(sorted, get().viewedChannelId),
    });
  },

  view(channelId) {
    set({ viewedChannelId: channelId });
  },

  reset() {
    set({ channels: [], loading: false, error: null, viewedChannelId: null });
  },
}));

export function selectChannel(state: ChannelsState, id: string | null): Channel | undefined {
  return id ? state.channels.find((channel) => channel.id === id) : undefined;
}
