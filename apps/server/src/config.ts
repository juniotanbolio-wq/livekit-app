import { existsSync } from 'node:fs';
import { z } from 'zod';

const durationSchema = z.string().regex(/^\d+[smhd]$/, 'use formato como 30m, 6h ou 7d');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().startsWith('file:'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: durationSchema.default('7d'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  LIVEKIT_URL: z.url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  LIVEKIT_TOKEN_TTL: durationSchema.default('6h'),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(72),
  SEED_ADMIN_USERNAME: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) {
    return cached;
  }
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Configuração inválida:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}
