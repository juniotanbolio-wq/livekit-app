import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IpcChannel,
  NOTICE_TEXT_MAX_LENGTH,
  SERVER_URL_MAX_LENGTH,
  SESSION_MAX_LENGTH,
  type DesktopConfig,
  type SetServerResult,
} from '../shared/desktop-api';
import type { MainConfig } from './config';
import { showMentionNotification } from './notifications';
import { appOrigin } from './security';
import { ServerCheckError, checkServer } from './server-check';
import { clearSession, readSession, writeSession } from './session-store';
import type { ServerSettings } from './settings-store';

const sessionValueSchema = z.string().min(1).max(SESSION_MAX_LENGTH);
const serverInputSchema = z.string().max(SERVER_URL_MAX_LENGTH);
const mentionNoticeSchema = z.object({
  from: z.string().min(1).max(NOTICE_TEXT_MAX_LENGTH),
  message: z.string().max(NOTICE_TEXT_MAX_LENGTH).nullable(),
});

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

export interface IpcDeps {
  config: MainConfig;
  getSettings(): ServerSettings;
  // Salva as configurações e recalcula a CSP.
  applySettings(next: ServerSettings): Promise<void>;
  getWindow(): BrowserWindow | null;
  showWindow(): void;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { config } = deps;

  ipcMain.handle(IpcChannel.configGet, (event): DesktopConfig => {
    assertTrustedSender(event, config);
    const settings = deps.getSettings();
    return {
      serverUrl: settings.serverUrl,
      liveKitUrl: settings.liveKitUrl,
      defaultServerUrl: config.defaultServerUrl,
    };
  });

  // Erros de validação voltam como valor (e não como exceção) para o renderer mostrar a mensagem exata,
  // sem o prefixo técnico que o Electron põe em exceções de ipcRenderer.invoke.
  ipcMain.handle(IpcChannel.serverSet, async (event, value: unknown): Promise<SetServerResult> => {
    assertTrustedSender(event, config);
    const input = serverInputSchema.parse(value);
    try {
      const checked = await checkServer(input);
      // O token de sessão foi emitido por outro servidor: não vale (nem deve ser enviado) no novo.
      if (deps.getSettings().serverUrl !== checked.serverUrl) {
        await clearSession();
      }
      await deps.applySettings(checked);
      return { ok: true, serverUrl: checked.serverUrl };
    } catch (err) {
      if (err instanceof ServerCheckError) {
        return { ok: false, error: err.message };
      }
      console.error('Falha ao salvar o servidor:', err);
      return { ok: false, error: 'Falha inesperada ao salvar o endereço do servidor' };
    }
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

  ipcMain.handle(IpcChannel.mentionNotify, (event, value: unknown) => {
    assertTrustedSender(event, config);
    showMentionNotification(mentionNoticeSchema.parse(value), deps.getWindow(), deps.showWindow);
  });
}
