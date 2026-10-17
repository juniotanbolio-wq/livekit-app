import { create } from 'zustand';
import type { WsMention } from '../lib/realtime';

export interface ReceivedMention {
  id: string;
  fromUsername: string;
  message: string | null;
  sentAt: string;
}

// Mantém só os avisos mais recentes na tela; menções não são persistidas (nem no servidor).
const MAX_VISIBLE = 5;

interface MentionsState {
  received: ReceivedMention[];
  receive(mention: WsMention): void;
  dismiss(id: string): void;
  reset(): void;
}

export const useMentions = create<MentionsState>()((set) => ({
  received: [],

  receive(mention) {
    const item: ReceivedMention = {
      id: crypto.randomUUID(),
      fromUsername: mention.from.username,
      message: mention.message ?? null,
      sentAt: mention.sentAt,
    };
    set((state) => ({ received: [item, ...state.received].slice(0, MAX_VISIBLE) }));
  },

  dismiss(id) {
    set((state) => ({ received: state.received.filter((item) => item.id !== id) }));
  },

  reset() {
    set({ received: [] });
  },
}));
