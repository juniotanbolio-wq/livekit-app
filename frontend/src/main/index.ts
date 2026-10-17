import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { loadMainConfig, type MainConfig } from './config';
import { registerIpcHandlers } from './ipc';
import { registerScreenCapture } from './screen-capture';
import {
  APP_ORIGIN,
  applySessionSecurity,
  buildCsp,
  enforceGlobalHardening,
  registerAppProtocol,
  registerAppScheme,
} from './security';

let mainWindow: BrowserWindow | null = null;

// Janela única do app. As opções de webPreferences abaixo formam a base de segurança do Electron:
// o renderer fala com servidores remotos, então não pode ter acesso a Node nem ao processo
// principal além do que o preload expõe.
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
      // Isola o preload do código da página; sem isso a página alcançaria as APIs do Electron.
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

// Ordem importa: o esquema `app://` e o endurecimento global precisam ser registrados antes de
// `ready`; protocolo, CSP e sessão só depois. Os handlers de IPC entram antes da janela abrir.
function start(): void {
  const config = loadMainConfig();
  if (config.userDataDir) {
    app.setPath('userData', config.userDataDir);
  }

  // Instância única evita duas cópias disputando sessão cifrada e dispositivos de mídia.
  // multiInstance existe só para testar voz com duas instâncias na mesma máquina (dev:second).
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
    registerScreenCapture(config);
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
