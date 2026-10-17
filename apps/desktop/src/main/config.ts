import { resolve } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';

const httpUrlSchema = z.url({ protocol: /^https?$/ });
const wsUrlSchema = z.url({ protocol: /^wss?$/ });

const envSchema = z.object({
  LIVEKIT_APP_SERVER_URL: httpUrlSchema.default('http://localhost:3000'),
  LIVEKIT_APP_LIVEKIT_URL: wsUrlSchema.default('ws://localhost:7880'),
});

export interface MainConfig {
  serverUrl: string;
  liveKitUrl: string;
  rendererDevUrl: string | null;
  userDataDir: string | null;
  multiInstance: boolean;
}

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolveRendererDevUrl(): string | null {
  if (app.isPackaged) {
    return null;
  }
  const candidate = readArg('renderer-url') ?? process.env['ELECTRON_RENDERER_URL'] ?? null;
  if (!candidate) {
    return null;
  }
  return httpUrlSchema.parse(candidate);
}

export function loadMainConfig(): MainConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Configuração inválida:\n${z.prettifyError(parsed.error)}`);
  }
  const userDataArg = readArg('user-data-dir');
  return {
    serverUrl: parsed.data.LIVEKIT_APP_SERVER_URL.replace(/\/+$/, ''),
    liveKitUrl: parsed.data.LIVEKIT_APP_LIVEKIT_URL.replace(/\/+$/, ''),
    rendererDevUrl: resolveRendererDevUrl(),
    userDataDir: userDataArg ? resolve(userDataArg) : null,
    multiInstance: hasFlag('multi-instance'),
  };
}
