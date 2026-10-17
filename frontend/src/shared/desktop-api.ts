export interface DesktopConfig {
  serverUrl: string;
}

export type ScreenSourceKind = 'screen' | 'window';

export interface ScreenSource {
  id: string;
  name: string;
  kind: ScreenSourceKind;
  thumbnail: string;
  appIcon: string | null;
}

export interface DesktopApi {
  platform: string;
  getConfig(): Promise<DesktopConfig>;
  getSession(): Promise<string | null>;
  setSession(value: string): Promise<void>;
  clearSession(): Promise<void>;
  listScreenSources(): Promise<ScreenSource[]>;
  selectScreenSource(sourceId: string, includeAudio: boolean): Promise<void>;
}

export const IpcChannel = {
  configGet: 'config:get',
  sessionGet: 'session:get',
  sessionSet: 'session:set',
  sessionClear: 'session:clear',
  screenListSources: 'screen:list-sources',
  screenSelectSource: 'screen:select-source',
} as const;

export const SESSION_MAX_LENGTH = 16384;
