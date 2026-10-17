import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IpcChannel, SESSION_MAX_LENGTH, type DesktopConfig } from '../shared/desktop-api';
import type { MainConfig } from './config';
import { appOrigin } from './security';
import { clearSession, readSession, writeSession } from './session-store';

const sessionValueSchema = z.string().min(1).max(SESSION_MAX_LENGTH);

export function assertTrustedSender(event: IpcMainInvokeEvent, config: MainConfig): void {
  const url = event.senderFrame?.url;
  if (!url) {
    throw new Error('Remetente IPC desconhecido');
  }
  const parsed = new URL(url);
  if (`${parsed.protocol}//${parsed.host}` !== appOrigin(config)) {
    throw new Error('Remetente IPC não autorizado');
  }
}

export function registerIpcHandlers(config: MainConfig): void {
  const desktopConfig: DesktopConfig = { serverUrl: config.serverUrl };

  ipcMain.handle(IpcChannel.configGet, (event) => {
    assertTrustedSender(event, config);
    return desktopConfig;
  });

  ipcMain.handle(IpcChannel.sessionGet, async (event) => {
    assertTrustedSender(event, config);
    return readSession();
  });

  ipcMain.handle(IpcChannel.sessionSet, async (event, value: unknown) => {
    assertTrustedSender(event, config);
    await writeSession(sessionValueSchema.parse(value));
  });

  ipcMain.handle(IpcChannel.sessionClear, async (event) => {
    assertTrustedSender(event, config);
    await clearSession();
  });
}
