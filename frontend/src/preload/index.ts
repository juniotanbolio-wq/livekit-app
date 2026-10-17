import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type DesktopApi,
  type DesktopConfig,
  type ScreenSource,
  type SetServerResult,
} from '../shared/desktop-api';

// Superfície mínima exposta ao renderer: só funções específicas, nunca o ipcRenderer inteiro.
// O processo principal revalida o remetente e o formato de cada chamada (assertTrustedSender + zod),
// então este arquivo não é uma fronteira de confiança por si só.
const api: DesktopApi = {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke(IpcChannel.configGet) as Promise<DesktopConfig>,
  setServer: (url) => ipcRenderer.invoke(IpcChannel.serverSet, url) as Promise<SetServerResult>,
  getSession: () => ipcRenderer.invoke(IpcChannel.sessionGet) as Promise<string | null>,
  setSession: (value) => ipcRenderer.invoke(IpcChannel.sessionSet, value) as Promise<void>,
  clearSession: () => ipcRenderer.invoke(IpcChannel.sessionClear) as Promise<void>,
  notifyMention: (notice) => ipcRenderer.invoke(IpcChannel.mentionNotify, notice) as Promise<void>,
  listScreenSources: () =>
    ipcRenderer.invoke(IpcChannel.screenListSources) as Promise<ScreenSource[]>,
  selectScreenSource: (sourceId, includeAudio) =>
    ipcRenderer.invoke(IpcChannel.screenSelectSource, { sourceId, includeAudio }) as Promise<void>,
};

// contextBridge copia os valores entre mundos isolados, em vez de compartilhar referências.
contextBridge.exposeInMainWorld('desktop', api);
