import { join } from 'node:path';
import { app, BrowserWindow, dialog, type Tray } from 'electron';
import { loadMainConfig, type MainConfig } from './config';
import { registerIpcHandlers } from './ipc';
import { registerScreenCapture } from './screen-capture';
import {
  APP_ORIGIN,
  applySessionSecurity,
  enforceGlobalHardening,
  registerAppProtocol,
  registerAppScheme,
  updateCsp,
} from './security';
import { loadSettings, saveSettings, type ServerSettings } from './settings-store';
import { createTray } from './tray';

// Identificador do app para os toasts do Windows. Empacotado, precisa coincidir com o appId do instalador
// (R4); em desenvolvimento o Electron recomenda o caminho do executável.
const APP_USER_MODEL_ID = 'app.livekit.desktop';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Só "Sair" (bandeja) ou o encerramento do sistema fecham o app; o X da janela apenas a esconde.
let quitting = false;
let trayHintShown = false;

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
      // Escondido na bandeja o app continua em uso: recebe menções, mantém a voz e reconecta o WebSocket.
      // Com o estrangulamento padrão do Chromium, os timers de janela oculta caem para 1 por minuto e a
      // reconexão (e os timers do LiveKit) atrasariam demais.
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  // Desligamento ou logoff do Windows: fechar de verdade, senão o "esconder" abaixo seguraria a sessão.
  window.on('session-end', () => {
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting) {
      return;
    }
    // Fechar só esconde: o app segue conectado para receber "chamar atenção" e manter a voz.
    event.preventDefault();
    window.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        title: 'LiveKit App continua aberto',
        content:
          'O app segue na bandeja para receber chamadas de atenção. Use "Sair" no ícone para fechar.',
        iconType: 'info',
      });
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadURL(config.rendererDevUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

function showMainWindow(config: MainConfig): void {
  if (!mainWindow) {
    mainWindow = createWindow(config);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
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
  app.on('second-instance', () => showMainWindow(config));
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);

  registerAppScheme();
  enforceGlobalHardening(config);

  app.on('before-quit', () => {
    quitting = true;
  });

  void app.whenReady().then(async () => {
    // As configurações definem a CSP: precisam estar carregadas antes do primeiro documento.
    let settings: ServerSettings = await loadSettings();
    updateCsp(config, settings);
    registerAppProtocol(join(__dirname, '../renderer'));
    applySessionSecurity(config);
    registerIpcHandlers({
      config,
      getSettings: () => settings,
      applySettings: async (next) => {
        await saveSettings(next);
        settings = next;
        updateCsp(config, settings);
      },
      getWindow: () => mainWindow,
      showWindow: () => showMainWindow(config),
    });
    registerScreenCapture(config);
    tray = createTray({
      open: () => showMainWindow(config),
      quit: () => app.quit(),
    });
    mainWindow = createWindow(config);

    app.on('activate', () => showMainWindow(config));
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
