import type { Message, MessageHistoryQuery, MessageHistoryResponse } from '@livekit-app/shared';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { getChannelOfType } from './channels.js';

const messageInclude = { author: { select: { id: true, username: true } } } as const;

type MessageWithAuthor = {
  id: string;
  channelId: string;
  content: string;
  createdAt: Date;
  author: { id: string; username: string };
};

function toMessageDto(message: MessageWithAuthor): Message {
  return {
    id: message.id,
    channelId: message.channelId,
    author: { id: message.author.id, username: message.author.username },
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

export async function listMessages(
  channelId: string,
  query: MessageHistoryQuery,
): Promise<MessageHistoryResponse> {
  await getChannelOfType(channelId, 'text');
  if (query.before) {
    const cursor = await prisma.message.findFirst({
      where: { id: query.before, channelId },
      select: { id: true },
    });
    if (!cursor) {
      throw new HttpError(400, 'Cursor inválido');
    }
  }
  const rows = await prisma.message.findMany({
    where: { channelId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    include: messageInclude,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  return {
    messages: page.map(toMessageDto),
    nextCursor: hasMore && last ? last.id : null,
  };
}

export async function createMessage(
  channelId: string,
  authorId: string,
  content: string,
): Promise<Message> {
  await getChannelOfType(channelId, 'text');
  const message = await prisma.message.create({
    data: { channelId, authorId, content },
    include: messageInclude,
  });
  return toMessageDto(message);
}
