import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  type DesktopCapturerSource,
  type NativeImage,
} from 'electron';
import { z } from 'zod';
import { IpcChannel, type ScreenSource } from '../shared/desktop-api';
import type { MainConfig } from './config';
import { assertTrustedSender } from './ipc';
import { appOrigin } from './security';

const SELECTION_TTL_MS = 10_000;
const THUMBNAIL_SIZE = { width: 320, height: 180 };

const selectSchema = z.object({
  sourceId: z.string().min(1).max(256),
  includeAudio: z.boolean(),
});

interface PendingSelection {
  source: DesktopCapturerSource;
  includeAudio: boolean;
  expiresAt: number;
}

let knownSources = new Map<string, DesktopCapturerSource>();
let pending: PendingSelection | null = null;

function toDataUrl(image: NativeImage, format: 'jpeg' | 'png'): string | null {
  if (image.isEmpty()) {
    return null;
  }
  const buffer = format === 'jpeg' ? image.toJPEG(75) : image.toPNG();
  return `data:image/${format};base64,${buffer.toString('base64')}`;
}

function ownMediaSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      ids.add(window.getMediaSourceId());
    } catch {
      continue;
    }
  }
  return ids;
}

async function listSources(): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: true,
  });
  const ownIds = ownMediaSourceIds();
  const visible = sources.filter((source) => !ownIds.has(source.id));
  knownSources = new Map(visible.map((source) => [source.id, source]));
  return visible.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: toDataUrl(source.thumbnail, 'jpeg') ?? '',
    appIcon: source.appIcon ? toDataUrl(source.appIcon, 'png') : null,
  }));
}

async function resolveSource(sourceId: string): Promise<DesktopCapturerSource> {
  const cached = knownSources.get(sourceId);
  if (cached) {
    return cached;
  }
  await listSources();
  const refreshed = knownSources.get(sourceId);
  if (!refreshed) {
    throw new Error('A tela ou janela escolhida não está mais disponível');
  }
  return refreshed;
}

function frameOrigin(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function registerScreenCapture(config: MainConfig): void {
  const ownOrigin = appOrigin(config);
  const loopbackSupported = process.platform === 'win32';

  ipcMain.handle(IpcChannel.screenListSources, async (event) => {
    assertTrustedSender(event, config);
    return listSources();
  });

  ipcMain.handle(IpcChannel.screenSelectSource, async (event, payload: unknown) => {
    assertTrustedSender(event, config);
    const { sourceId, includeAudio } = selectSchema.parse(payload);
    const source = await resolveSource(sourceId);
    pending = {
      source,
      includeAudio: includeAudio && loopbackSupported,
      expiresAt: Date.now() + SELECTION_TTL_MS,
    };
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const selection = pending;
    pending = null;
    if (frameOrigin(request.frame?.url) !== ownOrigin) {
      callback(null);
      return;
    }
    if (!selection || selection.expiresAt < Date.now() || !request.videoRequested) {
      callback(null);
      return;
    }
    if (selection.includeAudio && request.audioRequested) {
      callback({ video: selection.source, audio: 'loopback' });
      return;
    }
    callback({ video: selection.source });
  });
}
