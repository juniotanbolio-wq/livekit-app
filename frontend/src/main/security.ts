import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { app, protocol, session, type WebContents } from 'electron';
import type { MainConfig } from './config';
import type { ServerSettings } from './settings-store';

export const APP_SCHEME = 'app';
export const APP_HOST = 'desktop';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const ALLOWED_PERMISSIONS = new Set([
  'media',
  'speaker-selection',
  'display-capture',
  'fullscreen',
]);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

export function appOrigin(config: MainConfig): string {
  return config.rendererDevUrl ? (toOrigin(config.rendererDevUrl) ?? APP_ORIGIN) : APP_ORIGIN;
}

function toOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

const SIBLING_PROTOCOL: Record<string, string> = {
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'http:',
  'wss:': 'https:',
};

function withSiblingProtocol(url: string): string[] {
  const parsed = new URL(url);
  const origins = [`${parsed.protocol}//${parsed.host}`];
  const sibling = SIBLING_PROTOCOL[parsed.protocol];
  if (sibling) {
    origins.push(`${sibling}//${parsed.host}`);
  }
  return origins;
}

// connect-src lista só o backend (REST + WebSocket) e o LiveKit (sinalização + /rtc/validate) salvos nas
// configurações. Antes de o usuário escolher um servidor, só 'self': nada de rede além do próprio app.
export function buildCsp(config: MainConfig, settings: ServerSettings): string {
  const connect = new Set<string>(["'self'"]);
  for (const url of [settings.serverUrl, settings.liveKitUrl]) {
    if (url) {
      for (const origin of withSiblingProtocol(url)) {
        connect.add(origin);
      }
    }
  }
  const scripts = ["'self'"];
  if (config.rendererDevUrl) {
    for (const origin of withSiblingProtocol(config.rendererDevUrl)) {
      connect.add(origin);
    }
    scripts.push("'unsafe-inline'");
  }
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

// A CSP muda quando o usuário troca de servidor. Ela vale por documento, então quem troca o servidor
// recarrega a página logo em seguida para a política nova entrar em vigor.
let currentCsp = "default-src 'none'";

export function updateCsp(config: MainConfig, settings: ServerSettings): void {
  currentCsp = buildCsp(config, settings);
}

export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = normalize(join(rendererDir, pathname));
    const rel = relative(rendererDir, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await readFile(filePath);
      const headers = new Headers({
        'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      if (extname(filePath).toLowerCase() === '.html') {
        headers.set('Content-Security-Policy', currentCsp);
      }
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function applySessionSecurity(config: MainConfig): void {
  const ses = session.defaultSession;
  const ownOrigin = appOrigin(config);

  if (config.rendererDevUrl) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (toOrigin(details.url) !== ownOrigin || details.resourceType !== 'mainFrame') {
        callback({});
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [currentCsp],
        },
      });
    });
  }

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = toOrigin(details.requestingUrl) ?? toOrigin(webContents.getURL());
    callback(origin === ownOrigin && ALLOWED_PERMISSIONS.has(permission));
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return toOrigin(requestingOrigin) === ownOrigin && ALLOWED_PERMISSIONS.has(permission);
  });
}

export function hardenWebContents(contents: WebContents, config: MainConfig): void {
  const ownOrigin = appOrigin(config);

  contents.on('will-navigate', (event, url) => {
    if (toOrigin(url) !== ownOrigin) {
      event.preventDefault();
    }
  });

  contents.on('will-redirect', (event, url) => {
    if (toOrigin(url) !== ownOrigin) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export function enforceGlobalHardening(config: MainConfig): void {
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, config);
  });
}
