import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';

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
