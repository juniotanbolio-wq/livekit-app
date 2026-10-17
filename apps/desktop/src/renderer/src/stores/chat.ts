import { create } from 'zustand';
import {
  MESSAGE_PAGE_DEFAULT_LIMIT,
  messageHistoryResponseSchema,
  type Message,
} from '@livekit-app/shared';
import { errorMessage, request } from '../lib/api';

export interface ChannelChat {
  messages: Message[];
  nextCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loadingInitial: boolean;
  loadingOlder: boolean;
  error: string | null;
}

interface ChatState {
  byChannel: Record<string, ChannelChat>;
  loadInitial(channelId: string): Promise<void>;
  loadOlder(channelId: string): Promise<void>;
  resync(channelId: string): Promise<void>;
  receive(message: Message): void;
  reset(): void;
}

export const emptyChannelChat: ChannelChat = {
  messages: [],
  nextCursor: null,
  hasMore: true,
  loaded: false,
  loadingInitial: false,
  loadingOlder: false,
  error: null,
};

function compareMessages(a: Message, b: Message): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of current) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(compareMessages);
}

function fetchPage(channelId: string, before?: string) {
  return request(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    schema: messageHistoryResponseSchema,
    query: { limit: MESSAGE_PAGE_DEFAULT_LIMIT, before },
  });
}

export const useChat = create<ChatState>()((set, get) => {
  const update = (channelId: string, patch: Partial<ChannelChat>): void => {
    set((state) => ({
      byChannel: {
        ...state.byChannel,
        [channelId]: { ...(state.byChannel[channelId] ?? emptyChannelChat), ...patch },
      },
    }));
  };

  const current = (channelId: string): ChannelChat =>
    get().byChannel[channelId] ?? emptyChannelChat;

  return {
    byChannel: {},

    async loadInitial(channelId) {
      const chat = current(channelId);
      if (chat.loaded || chat.loadingInitial) {
        return;
      }
      update(channelId, { loadingInitial: true, error: null });
      try {
        const page = await fetchPage(channelId);
        update(channelId, {
          messages: mergeMessages(current(channelId).messages, page.messages),
          nextCursor: page.nextCursor,
          hasMore: page.nextCursor !== null,
          loaded: true,
        });
      } catch (err) {
        update(channelId, { error: errorMessage(err) });
      } finally {
        update(channelId, { loadingInitial: false });
      }
    },

    async loadOlder(channelId) {
      const chat = current(channelId);
      if (!chat.loaded || !chat.hasMore || chat.loadingOlder || !chat.nextCursor) {
        return;
      }
      update(channelId, { loadingOlder: true, error: null });
      try {
        const page = await fetchPage(channelId, chat.nextCursor);
        update(channelId, {
          messages: mergeMessages(current(channelId).messages, page.messages),
          nextCursor: page.nextCursor,
          hasMore: page.nextCursor !== null,
        });
      } catch (err) {
        update(channelId, { error: errorMessage(err) });
      } finally {
        update(channelId, { loadingOlder: false });
      }
    },

    async resync(channelId) {
      if (!current(channelId).loaded) {
        return;
      }
      try {
        const page = await fetchPage(channelId);
        update(channelId, {
          messages: mergeMessages(current(channelId).messages, page.messages),
          error: null,
        });
      } catch (err) {
        update(channelId, { error: errorMessage(err) });
      }
    },

    receive(message) {
      const chat = current(message.channelId);
      update(message.channelId, { messages: mergeMessages(chat.messages, [message]) });
    },

    reset() {
      set({ byChannel: {} });
    },
  };
});
