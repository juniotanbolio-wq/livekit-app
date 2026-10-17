import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';

// Endereços do servidor escolhidos pelo usuário. Não são segredo (ficam em texto no userData), mas definem
// a CSP: por isso só entram aqui depois de validados por server-check.ts.
export interface ServerSettings {
  serverUrl: string | null;
  liveKitUrl: string | null;
}

const settingsSchema = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }).nullable(),
  liveKitUrl: z.url({ protocol: /^wss?$/ }).nullable(),
});

const EMPTY: ServerSettings = { serverUrl: null, liveKitUrl: null };

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<ServerSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Falha ao ler as configurações, usando o padrão:', err);
    }
    return EMPTY;
  }
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      // Servidor sem LiveKit (ou o contrário) é estado incompleto: pede o endereço de novo.
      return parsed.data.serverUrl && parsed.data.liveKitUrl ? parsed.data : EMPTY;
    }
  } catch {
    // JSON corrompido cai no aviso abaixo.
  }
  console.error('Configurações inválidas em settings.json, pedindo o servidor de novo');
  return EMPTY;
}

// Escrita atômica: grava num arquivo temporário e renomeia, para uma queda no meio não deixar JSON pela metade.
export async function saveSettings(settings: ServerSettings): Promise<void> {
  const file = settingsFile();
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(settingsSchema.parse(settings), null, 2), { mode: 0o600 });
  await rename(temp, file);
}
