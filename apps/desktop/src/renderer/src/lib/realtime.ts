import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  ClientToServerEvents,
  Message,
  SendMessageRequest,
  ServerToClientEvents,
} from '@livekit-app/shared';
import { getServerUrl } from './api';
import { useChat } from '../stores/chat';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface RealtimeState {
  status: RealtimeStatus;
  lastError: string | null;
}

export const useRealtime = create<RealtimeState>()(() => ({
  status: 'disconnected',
  lastError: null,
}));

const AUTH_ERRORS = new Set(['Não autenticado', 'Token inválido ou expirado']);
const ACK_TIMEOUT_MS = 10_000;

let socket: AppSocket | null = null;
let authFailureHandler: (() => void) | null = null;

export function onRealtimeAuthFailure(handler: () => void): void {
  authFailureHandler = handler;
}

export function connectRealtime(token: string): void {
  disconnectRealtime();
  const instance: AppSocket = io(getServerUrl(), {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket = instance;
  useRealtime.setState({ status: 'connecting', lastError: null });

  let hadConnection = false;

  instance.on('connect', () => {
    useRealtime.setState({ status: 'connected', lastError: null });
    if (hadConnection) {
      const chat = useChat.getState();
      for (const channelId of Object.keys(chat.byChannel)) {
        void chat.resync(channelId);
      }
    }
    hadConnection = true;
  });

  instance.on('disconnect', (reason) => {
    if (socket !== instance) {
      return;
    }
    if (reason === 'io client disconnect') {
      useRealtime.setState({ status: 'disconnected' });
      return;
    }
    useRealtime.setState({ status: 'reconnecting' });
    if (reason === 'io server disconnect') {
      instance.connect();
    }
  });

  instance.on('connect_error', (err) => {
    if (socket !== instance) {
      return;
    }
    if (AUTH_ERRORS.has(err.message)) {
      useRealtime.setState({ status: 'disconnected', lastError: err.message });
      instance.disconnect();
      authFailureHandler?.();
      return;
    }
    useRealtime.setState({ status: 'reconnecting', lastError: err.message });
  });

  instance.on('message:new', (message: Message) => {
    useChat.getState().receive(message);
  });
}

export function disconnectRealtime(): void {
  if (!socket) {
    return;
  }
  const current = socket;
  socket = null;
  current.removeAllListeners();
  current.disconnect();
  useRealtime.setState({ status: 'disconnected', lastError: null });
}

export function sendMessage(payload: SendMessageRequest): Promise<Message> {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error('Sem conexão com o servidor. Tentando reconectar...'));
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit('message:send', payload, (err, response) => {
      if (err) {
        reject(new Error('O servidor não respondeu a tempo'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error));
        return;
      }
      useChat.getState().receive(response.data);
      resolve(response.data);
    });
  });
}
