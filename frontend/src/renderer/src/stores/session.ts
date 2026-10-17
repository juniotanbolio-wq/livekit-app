import { create } from 'zustand';
import {
  ApiError,
  initApi,
  listChannels,
  login as apiLogin,
  register as apiRegister,
  setAuthToken,
  setUnauthorizedHandler,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '../lib/api';
import { isRecord, isString } from '../lib/guards';
import { useChannels } from './channels';
import { useMentions } from './mentions';
import { usePresence } from './presence';
import { useRealtime } from './realtime';

// needs-server: primeira execução (ou configuração perdida); o app pede o endereço do servidor.
type SessionStatus = 'booting' | 'needs-server' | 'anonymous' | 'authenticated';

const EXPIRED_NOTICE = 'Sua sessão expirou. Entre novamente.';

interface SessionState {
  status: SessionStatus;
  token: string | null;
  user: User | null;
  notice: string | null;
  serverUrl: string | null;
  liveKitUrl: string | null;
  defaultServerUrl: string | null;
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
  useMentions.getState().reset();
}

// A sessão salva é dado local (cifrado pelo safeStorage), mas pode estar corrompida ou ser de uma
// versão antiga do app: confere o formato antes de usar.
function isStoredSession(value: unknown): value is AuthResponse {
  if (!isRecord(value) || !isString(value['token']) || value['token'].length === 0) {
    return false;
  }
  const user = value['user'];
  return (
    isRecord(user) &&
    isString(user['id']) &&
    isString(user['username']) &&
    typeof user['isAdmin'] === 'boolean' &&
    isString(user['createdAt'])
  );
}

async function persist(token: string, user: User): Promise<void> {
  try {
    await window.desktop.setSession(JSON.stringify({ token, user } satisfies AuthResponse));
  } catch (err) {
    console.error('Falha ao salvar sessão:', err);
  }
}

async function readStoredSession(): Promise<AuthResponse | null> {
  try {
    const raw = await window.desktop.getSession();
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (isStoredSession(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.error('Sessão salva inválida:', err);
  }
  await window.desktop.clearSession();
  return null;
}

export const useSession = create<SessionState>()((set, get) => {
  // Sessão ativa = token na API REST + WebSocket aberto. O WebSocket recebe presença e menções.
  const enter = (token: string, user: User): void => {
    setAuthToken(token);
    set({ status: 'authenticated', token, user, notice: null });
    const { serverUrl } = get();
    if (serverUrl) {
      useRealtime.getState().start({
        serverUrl,
        token,
        onUnauthorized: () => {
          if (get().status === 'authenticated') {
            get().expire();
          }
        },
      });
    }
  };

  const endSession = async (notice: string | null): Promise<void> => {
    // Sair fecha o WebSocket na hora (código 1000): o servidor deixa de contar este usuário como conectado.
    useRealtime.getState().stop();
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
    serverUrl: null,
    liveKitUrl: null,
    defaultServerUrl: null,

    async boot() {
      let config;
      try {
        config = await window.desktop.getConfig();
      } catch (err) {
        console.error(err);
        set({ status: 'needs-server', notice: 'Falha ao carregar a configuração do app' });
        return;
      }
      set({
        serverUrl: config.serverUrl,
        liveKitUrl: config.liveKitUrl,
        defaultServerUrl: config.defaultServerUrl,
      });
      if (!config.serverUrl || !config.liveKitUrl) {
        set({ status: 'needs-server' });
        return;
      }
      initApi(config.serverUrl, config.liveKitUrl);

      const stored = await readStoredSession();
      if (!stored) {
        set({ status: 'anonymous' });
        return;
      }
      setAuthToken(stored.token);
      try {
        useChannels.getState().setChannels(await listChannels());
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await endSession(EXPIRED_NOTICE);
          return;
        }
        // Servidor fora do ar: entra assim mesmo; os canais são recarregados na tela principal e o
        // WebSocket fica tentando reconectar.
      }
      enter(stored.token, stored.user);
    },

    async login(input) {
      const response = await apiLogin(input);
      await persist(response.token, response.user);
      enter(response.token, response.user);
    },

    async register(input) {
      const response = await apiRegister(input);
      await persist(response.token, response.user);
      enter(response.token, response.user);
    },

    async logout() {
      await endSession(null);
    },

    expire() {
      void endSession(EXPIRED_NOTICE);
    },

    clearNotice() {
      set({ notice: null });
    },
  };
});
