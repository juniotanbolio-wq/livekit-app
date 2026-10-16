import { z } from 'zod';
import { usernameSchema, userSchema } from './user.js';

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
