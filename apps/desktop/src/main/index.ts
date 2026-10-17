import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { loadMainConfig, type MainConfig } from './config';
import { registerIpcHandlers } from './ipc';
import {
  APP_ORIGIN,
  applySessionSecurity,
  buildCsp,
  enforceGlobalHardening,
  registerAppProtocol,
  registerAppScheme,
} from './security';

let mainWindow: BrowserWindow | null = null;

function createWindow(config: MainConfig): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    title: 'LiveKit App',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadURL(config.rendererDevUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function start(): void {
  const config = loadMainConfig();
  if (config.userDataDir) {
    app.setPath('userData', config.userDataDir);
  }

  if (!config.multiInstance && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', focusMainWindow);

  registerAppScheme();
  enforceGlobalHardening(config);

  void app.whenReady().then(() => {
    const csp = buildCsp(config);
    registerAppProtocol(join(__dirname, '../renderer'), csp);
    applySessionSecurity(config, csp);
    registerIpcHandlers(config);
    mainWindow = createWindow(config);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow(config);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

try {
  start();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  dialog.showErrorBox('Falha ao iniciar', message);
  app.exit(1);
}
