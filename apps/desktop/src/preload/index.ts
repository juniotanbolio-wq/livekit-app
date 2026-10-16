import { contextBridge } from 'electron';
import type { DesktopApi } from './api';

const api: DesktopApi = {
  platform: process.platform,
};

contextBridge.exposeInMainWorld('desktop', api);
