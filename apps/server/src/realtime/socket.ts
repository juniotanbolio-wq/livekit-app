import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import {
  sendMessageRequestSchema,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from '@livekit-app/shared';
import { prisma } from '../db.js';
import { findUserByToken } from '../auth/users.js';
import { isOriginAllowed } from '../http/cors.js';
import { HttpError } from '../http/errors.js';
import { createMessage } from '../services/messages.js';

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

function channelRoom(channelId: string): string {
  return `channel:${channelId}`;
}

export function createRealtimeServer(httpServer: HttpServer): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        callback(null, isOriginAllowed(origin));
      },
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 64 * 1024,
  });

  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth['token'];
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('Não autenticado'));
      return;
    }
    try {
      const user = await findUserByToken(token);
      if (!user) {
        next(new Error('Token inválido ou expirado'));
        return;
      }
      socket.data.userId = user.id;
      socket.data.username = user.username;
      next();
    } catch (err) {
      console.error(err);
      next(new Error('Erro interno do servidor'));
    }
  });

  io.on('connection', async (socket) => {
    try {
      const textChannels = await prisma.channel.findMany({
        where: { type: 'text' },
        select: { id: true },
      });
      await socket.join(textChannels.map((channel) => channelRoom(channel.id)));
    } catch (err) {
      console.error(err);
      socket.disconnect(true);
      return;
    }

    socket.on('message:send', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const parsed = sendMessageRequestSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Mensagem inválida' });
        return;
      }
      try {
        const message = await createMessage(
          parsed.data.channelId,
          socket.data.userId,
          parsed.data.content,
        );
        io.to(channelRoom(message.channelId)).emit('message:new', message);
        respond({ ok: true, data: message });
      } catch (err) {
        if (err instanceof HttpError) {
          respond({ ok: false, error: err.message });
          return;
        }
        console.error(err);
        respond({ ok: false, error: 'Erro interno do servidor' });
      }
    });
  });

  return io;
}
