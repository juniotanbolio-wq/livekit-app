export interface DesktopConfig {
  serverUrl: string;
}

export interface DesktopApi {
  platform: string;
  getConfig(): Promise<DesktopConfig>;
  getSession(): Promise<string | null>;
  setSession(value: string): Promise<void>;
  clearSession(): Promise<void>;
}

export const IpcChannel = {
  configGet: 'config:get',
  sessionGet: 'session:get',
  sessionSet: 'session:set',
  sessionClear: 'session:clear',
} as const;

export const SESSION_MAX_LENGTH = 16384;
