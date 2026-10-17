// Tipos provisórios copiados de packages/shared (v1, tag v1-node), sem chat e sem Socket.IO.
// Serão substituídos na fase R2 pelos tipos gerados de contracts/openapi.yaml (openapi-typescript).
import { z } from 'zod';

export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.iso.datetime();

export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// Usuário
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_.-]+$/);

export const userSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  isAdmin: z.boolean(),
  createdAt: isoDateSchema,
});
export type User = z.infer<typeof userSchema>;

export const publicUserSchema = userSchema.pick({ id: true, username: true });
export type PublicUser = z.infer<typeof publicUserSchema>;

// Autenticação
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
export const inviteCodeSchema = z.string().trim().min(8).max(64);

export const registerRequestSchema = z.object({
  inviteCode: inviteCodeSchema,
  username: usernameSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authResponseSchema = z.object({
  token: z.string().min(1),
  user: userSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

// Canais (só de voz na v2: não há chat de texto)
export const VOICE_CHANNEL_COUNT = 7;

export const channelSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  position: z.number().int().nonnegative(),
});
export type Channel = z.infer<typeof channelSchema>;

export const channelListResponseSchema = z.object({
  channels: z.array(channelSchema),
});
export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;

// Token LiveKit
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

// Presença
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
