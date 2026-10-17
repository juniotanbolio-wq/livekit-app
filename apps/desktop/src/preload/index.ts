import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type DesktopApi,
  type DesktopConfig,
  type ScreenSource,
} from '../shared/desktop-api';

const api: DesktopApi = {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke(IpcChannel.configGet) as Promise<DesktopConfig>,
  getSession: () => ipcRenderer.invoke(IpcChannel.sessionGet) as Promise<string | null>,
  setSession: (value) => ipcRenderer.invoke(IpcChannel.sessionSet, value) as Promise<void>,
  clearSession: () => ipcRenderer.invoke(IpcChannel.sessionClear) as Promise<void>,
  listScreenSources: () =>
    ipcRenderer.invoke(IpcChannel.screenListSources) as Promise<ScreenSource[]>,
  selectScreenSource: (sourceId, includeAudio) =>
    ipcRenderer.invoke(IpcChannel.screenSelectSource, { sourceId, includeAudio }) as Promise<void>,
};

contextBridge.exposeInMainWorld('desktop', api);
