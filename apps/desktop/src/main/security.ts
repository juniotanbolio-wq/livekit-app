import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { app, protocol, session, type WebContents } from 'electron';
import type { MainConfig } from './config';

export const APP_SCHEME = 'app';
export const APP_HOST = 'desktop';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const ALLOWED_PERMISSIONS = new Set(['media', 'speaker-selection']);

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

export function buildCsp(config: MainConfig): string {
  const connect = new Set<string>(["'self'"]);
  for (const origin of withSiblingProtocol(config.serverUrl)) {
    connect.add(origin);
  }
  for (const origin of withSiblingProtocol(config.liveKitUrl)) {
    connect.add(origin);
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

export function registerAppProtocol(rendererDir: string, csp: string): void {
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
        headers.set('Content-Security-Policy', csp);
      }
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function applySessionSecurity(config: MainConfig, csp: string): void {
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
          'Content-Security-Policy': [csp],
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
