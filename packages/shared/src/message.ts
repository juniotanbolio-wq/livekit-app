import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';
import { publicUserSchema } from './user.js';

export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const MESSAGE_PAGE_MAX_LIMIT = 100;

export const messageContentSchema = z.string().trim().min(1).max(MESSAGE_MAX_LENGTH);

export const messageSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  author: publicUserSchema,
  content: messageContentSchema,
  createdAt: isoDateSchema,
});

export type Message = z.infer<typeof messageSchema>;

export const messageHistoryQuerySchema = z.object({
  before: idSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_PAGE_MAX_LIMIT)
    .default(MESSAGE_PAGE_DEFAULT_LIMIT),
});

export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export const messageHistoryResponseSchema = z.object({
  messages: z.array(messageSchema),
  nextCursor: idSchema.nullable(),
});

export type MessageHistoryResponse = z.infer<typeof messageHistoryResponseSchema>;

export const sendMessageRequestSchema = z.object({
  channelId: idSchema,
  content: messageContentSchema,
});

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
