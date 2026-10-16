import type { Message, SendMessageRequest } from './message.js';

export type SocketAck<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ServerToClientEvents {
  'message:new': (message: Message) => void;
}

export interface ClientToServerEvents {
  'message:send': (
    payload: SendMessageRequest,
    ack: (response: SocketAck<Message>) => void,
  ) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId: string;
  username: string;
}
