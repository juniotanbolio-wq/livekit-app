export interface DesktopConfig {
  // Endereço do backend validado e salvo (null na primeira execução: o renderer pede um).
  serverUrl: string | null;
  // Endereço público do LiveKit informado pelo backend em GET /health; a CSP só libera esta origem.
  liveKitUrl: string | null;
  // Sugestão para o campo de endereço na primeira execução.
  defaultServerUrl: string | null;
}

export type SetServerResult = { ok: true; serverUrl: string } | { ok: false; error: string };

export interface MentionNotice {
  from: string;
  message: string | null;
}

export type ScreenSourceKind = 'screen' | 'window';

export interface ScreenSource {
  id: string;
  name: string;
  kind: ScreenSourceKind;
  thumbnail: string;
  appIcon: string | null;
}

export interface GpuDevice {
  vendorId: number;
  deviceId: number;
  active: boolean;
  name: string | null;
  driverVersion: string | null;
}

export interface ProcessCpu {
  type: string;
  // Uso desde a leitura anterior, em % da CPU inteira (o Electron divide pelo número de processadores lógicos).
  cpuPercent: number;
}

// Só para o painel de depuração: o que o Chromium diz sobre a GPU e o custo de CPU de cada processo.
export interface DiagnosticsInfo {
  electron: string;
  chrome: string;
  // Valores de app.getGPUFeatureStatus() (ex.: video_encode: "enabled" = codificação por hardware disponível).
  gpuFeatures: Record<string, string>;
  gpus: GpuDevice[];
  // --enable-features efetivo da linha de comando do processo principal.
  enabledFeatures: string[];
  processes: ProcessCpu[];
}

export interface DesktopApi {
  platform: string;
  getConfig(): Promise<DesktopConfig>;
  setServer(url: string): Promise<SetServerResult>;
  getSession(): Promise<string | null>;
  setSession(value: string): Promise<void>;
  clearSession(): Promise<void>;
  notifyMention(notice: MentionNotice): Promise<void>;
  listScreenSources(): Promise<ScreenSource[]>;
  selectScreenSource(sourceId: string, includeAudio: boolean): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsInfo>;
}

export const IpcChannel = {
  configGet: 'config:get',
  serverSet: 'server:set',
  sessionGet: 'session:get',
  sessionSet: 'session:set',
  sessionClear: 'session:clear',
  mentionNotify: 'mention:notify',
  screenListSources: 'screen:list-sources',
  screenSelectSource: 'screen:select-source',
  diagnosticsGet: 'diagnostics:get',
} as const;

export const SESSION_MAX_LENGTH = 16384;
export const SERVER_URL_MAX_LENGTH = 2048;
// Limite de sanidade para o texto de notificação vindo do renderer (o servidor já limita a 140 caracteres).
export const NOTICE_TEXT_MAX_LENGTH = 512;
