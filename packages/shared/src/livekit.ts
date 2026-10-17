import { z } from 'zod';
import { idSchema } from './common.js';

export const SPECTATOR_IDENTITY_SUFFIX = '#spectator';

export const liveKitRoleSchema = z.enum(['voice', 'spectator']);

export type LiveKitRole = z.infer<typeof liveKitRoleSchema>;

export const liveKitTokenRequestSchema = z.object({
  channelId: idSchema,
  role: liveKitRoleSchema,
});

export type LiveKitTokenRequest = z.infer<typeof liveKitTokenRequestSchema>;

export const liveKitTokenResponseSchema = z.object({
  token: z.string().min(1),
  url: z.url(),
  roomName: z.string().min(1),
});

export type LiveKitTokenResponse = z.infer<typeof liveKitTokenResponseSchema>;
