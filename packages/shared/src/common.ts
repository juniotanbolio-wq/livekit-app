import { z } from 'zod';

export const idSchema = z.string().min(1).max(64);

export const isoDateSchema = z.iso.datetime();

export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
