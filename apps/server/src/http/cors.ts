import type { CorsOptions } from 'cors';
import { loadConfig } from '../config.js';

export function isOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined || loadConfig().CORS_ORIGINS.includes(origin);
}

export function corsOptions(): CorsOptions {
  return {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  };
}
