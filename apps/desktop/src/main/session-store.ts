import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

let memorySession: string | null = null;
let warned = false;

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.bin');
}

function canEncrypt(): boolean {
  const available = safeStorage.isEncryptionAvailable();
  if (!available && !warned) {
    warned = true;
    console.warn('safeStorage indisponível: a sessão ficará apenas em memória');
  }
  return available;
}

export async function readSession(): Promise<string | null> {
  if (!canEncrypt()) {
    return memorySession;
  }
  const file = sessionFile();
  if (!existsSync(file)) {
    return null;
  }
  try {
    return safeStorage.decryptString(await readFile(file));
  } catch (err) {
    console.error('Sessão salva ilegível, descartando:', err);
    await rm(file, { force: true });
    return null;
  }
}

export async function writeSession(value: string): Promise<void> {
  if (!canEncrypt()) {
    memorySession = value;
    return;
  }
  await writeFile(sessionFile(), safeStorage.encryptString(value), { mode: 0o600 });
}

export async function clearSession(): Promise<void> {
  memorySession = null;
  await rm(sessionFile(), { force: true });
}
