import { z } from 'zod';
import { idSchema } from './common.js';

export const TEXT_CHANNEL_COUNT = 1;
export const VOICE_CHANNEL_COUNT = 7;

export const channelTypeSchema = z.enum(['text', 'voice']);

export type ChannelType = z.infer<typeof channelTypeSchema>;

export const channelSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  type: channelTypeSchema,
  position: z.number().int().nonnegative(),
});

export type Channel = z.infer<typeof channelSchema>;

export const channelListResponseSchema = z.object({
  channels: z.array(channelSchema),
});

export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;
