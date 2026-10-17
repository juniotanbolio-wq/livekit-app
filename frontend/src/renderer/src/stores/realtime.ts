import { create } from 'zustand';
import { RealtimeClient, realtimeUrl, type RealtimeStatus } from '../lib/realtime';
import { useMentions } from './mentions';
import { usePresence } from './presence';

interface StartOptions {
  serverUrl: string;
  token: string;
  onUnauthorized(): void;
}

interface RealtimeState {
  status: RealtimeStatus;
  start(options: StartOptions): void;
  stop(): void;
  sendMention(targetUserId: string, message: string | null): Promise<void>;
}

// Uma conexão por sessão: aberta ao autenticar e fechada ao sair (stores/session.ts).
let client: RealtimeClient | null = null;

export const useRealtime = create<RealtimeState>()((set) => ({
  status: 'idle',

  start({ serverUrl, token, onUnauthorized }) {
    client?.stop();
    client = new RealtimeClient(realtimeUrl(serverUrl), token, {
      onStatus: (status) => set({ status }),
      onSnapshot: (message) => usePresence.getState().applySnapshot(message.channels),
      onPresenceEvent: (event) => usePresence.getState().applyEvent(event),
      onMention: (mention) => {
        useMentions.getState().receive(mention);
        // Toast do Windows com som, mesmo com a janela escondida na bandeja.
        window.desktop
          .notifyMention({ from: mention.from.username, message: mention.message ?? null })
          .catch((err: unknown) => console.error('Falha ao pedir a notificação:', err));
      },
      onUnauthorized,
    });
    client.start();
  },

  stop() {
    client?.stop();
    client = null;
    set({ status: 'idle' });
  },

  sendMention(targetUserId, message) {
    if (!client) {
      return Promise.reject(new Error('Sem conexão com o servidor'));
    }
    return client.sendMention(targetUserId, message);
  },
}));
