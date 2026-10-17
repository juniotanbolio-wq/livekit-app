import { z } from 'zod';
import { idSchema } from './common.js';

export const PRESENCE_POLL_INTERVAL_MS = 5000;

export const presenceParticipantSchema = z.object({
  userId: idSchema,
  username: z.string(),
  isScreenSharing: z.boolean(),
});

export type PresenceParticipant = z.infer<typeof presenceParticipantSchema>;

export const channelPresenceSchema = z.object({
  channelId: idSchema,
  participants: z.array(presenceParticipantSchema),
});

export type ChannelPresence = z.infer<typeof channelPresenceSchema>;

export const presenceResponseSchema = z.object({
  channels: z.array(channelPresenceSchema),
});

export type PresenceResponse = z.infer<typeof presenceResponseSchema>;
