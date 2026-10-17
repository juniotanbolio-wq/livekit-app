import { create } from 'zustand';
import type { z } from 'zod';
import {
  authResponseSchema,
  channelListResponseSchema,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '../../../api/types';
import { ApiError, initApi, request, setAuthToken, setUnauthorizedHandler } from '../lib/api';
import { useChannels } from './channels';
import { usePresence } from './presence';

const storedSessionSchema = authResponseSchema;

type SessionStatus = 'booting' | 'anonymous' | 'authenticated';

interface SessionState {
  status: SessionStatus;
  token: string | null;
  user: User | null;
  notice: string | null;
  boot(): Promise<void>;
  login(input: LoginRequest): Promise<void>;
  register(input: RegisterRequest): Promise<void>;
  logout(): Promise<void>;
  expire(): void;
  clearNotice(): void;
}

function resetDataStores(): void {
  useChannels.getState().reset();
  usePresence.getState().reset();
}

async function persist(token: string, user: User): Promise<void> {
  try {
    await window.desktop.setSession(JSON.stringify({ token, user }));
  } catch (err) {
    console.error('Falha ao salvar sessão:', err);
  }
}

async function readStoredSession(): Promise<z.infer<typeof storedSessionSchema> | null> {
  try {
    const raw = await window.desktop.getSession();
    if (!raw) {
      return null;
    }
    const parsed = storedSessionSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data;
    }
  } catch (err) {
    console.error('Sessão salva inválida:', err);
  }
  await window.desktop.clearSession();
  return null;
}

export const useSession = create<SessionState>()((set, get) => {
  const authenticate = async (token: string, user: User): Promise<void> => {
    setAuthToken(token);
    await persist(token, user);
    set({ status: 'authenticated', token, user, notice: null });
  };

  const endSession = async (notice: string | null): Promise<void> => {
    setAuthToken(null);
    resetDataStores();
    set({ status: 'anonymous', token: null, user: null, notice });
    try {
      await window.desktop.clearSession();
    } catch (err) {
      console.error('Falha ao limpar sessão:', err);
    }
  };

  setUnauthorizedHandler(() => {
    if (get().status === 'authenticated') {
      get().expire();
    }
  });

  return {
    status: 'booting',
    token: null,
    user: null,
    notice: null,

    async boot() {
      try {
        await initApi();
      } catch (err) {
        console.error(err);
        set({ status: 'anonymous', notice: 'Falha ao carregar a configuração do app' });
        return;
      }
      const stored = await readStoredSession();
      if (!stored) {
        set({ status: 'anonymous' });
        return;
      }
      setAuthToken(stored.token);
      try {
        const { channels } = await request('/api/channels', { schema: channelListResponseSchema });
        useChannels.getState().setChannels(channels);
        set({ status: 'authenticated', token: stored.token, user: stored.user });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await endSession('Sua sessão expirou. Entre novamente.');
          return;
        }
        set({ status: 'authenticated', token: stored.token, user: stored.user });
      }
    },

    async login(input) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        body: input,
        schema: authResponseSchema,
        auth: false,
      });
      await authenticate(response.token, response.user);
    },

    async register(input) {
      const response = await request('/api/auth/register', {
        method: 'POST',
        body: input,
        schema: authResponseSchema,
        auth: false,
      });
      await authenticate(response.token, response.user);
    },

    async logout() {
      await endSession(null);
    },

    expire() {
      void endSession('Sua sessão expirou. Entre novamente.');
    },

    clearNotice() {
      set({ notice: null });
    },
  };
});
