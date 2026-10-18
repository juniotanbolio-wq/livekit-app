import { resolve } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';

const httpUrlSchema = z.url({ protocol: /^https?$/ });

// Backend do Compose de desenvolvimento (infra/docker-compose.yml).
const DEV_SERVER_URL = 'http://localhost:8080';

export interface MainConfig {
  rendererDevUrl: string | null;
  userDataDir: string | null;
  multiInstance: boolean;
  // Sugestão para a tela de primeira execução. Fora do pacote aponta para o backend local; empacotado fica
  // vazio até a R4 trazer o endereço do servidor pré-preenchido. O endereço de verdade fica em settings.json.
  // `--default-server-url=` troca a sugestão (aceite isolado e "Iniciar teste"); é só o valor inicial do
  // campo: o processo principal ainda valida o servidor com GET /health antes de salvar.
  defaultServerUrl: string | null;
  // `--no-hw-encode-flags`: não liga as features do Chromium para codificação de vídeo por hardware
  // (main/media-flags.ts). Serve para medir com e sem elas e para contornar driver de GPU com defeito.
  hwEncodeFlags: boolean;
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

function resolveDefaultServerUrl(): string | null {
  const candidate = readArg('default-server-url');
  if (candidate) {
    return httpUrlSchema.parse(candidate);
  }
  return app.isPackaged ? null : DEV_SERVER_URL;
}

export function loadMainConfig(): MainConfig {
  const userDataArg = readArg('user-data-dir');
  return {
    rendererDevUrl: resolveRendererDevUrl(),
    userDataDir: userDataArg ? resolve(userDataArg) : null,
    multiInstance: hasFlag('multi-instance'),
    defaultServerUrl: resolveDefaultServerUrl(),
    hwEncodeFlags: !hasFlag('no-hw-encode-flags'),
  };
}
