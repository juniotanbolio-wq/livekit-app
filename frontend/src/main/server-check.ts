import { net } from 'electron';
import { z } from 'zod';
import type { components } from '../generated/api';
import type { ServerSettings } from './settings-store';

type HealthResponse = components['schemas']['HealthResponse'];

const HEALTH_TIMEOUT_MS = 5000;

// Hosts em que conexão sem TLS é aceita. Fora deles o Chromium trata http/ws a partir do app:// (origem
// segura) como conteúdo misto, e o plano exige TLS para qualquer servidor real.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// O schema fica amarrado ao tipo gerado do contrato: se o HealthResponse mudar, o typecheck acusa aqui.
const healthSchema = z.object({
  status: z.literal('ok'),
  livekitUrl: z.string().min(1).max(2048),
}) satisfies z.ZodType<HealthResponse>;

// Erro com mensagem já pronta para o usuário.
export class ServerCheckError extends Error {
  override name = 'ServerCheckError';
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

// Aceita o que a pessoa digitar ("localhost:8080", "meuservidor.com", "https://x/health") e reduz à origem.
// Sem esquema: http para localhost (o Compose de dev) e https para o resto.
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ServerCheckError('Informe o endereço do servidor');
  }
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = trimmed.split(/[/:]/, 1)[0] ?? '';
    candidate = `${isLocalHost(host) ? 'http' : 'https'}://${trimmed}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ServerCheckError('Endereço inválido. Exemplo: https://meuservidor.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerCheckError('Use um endereço que comece com https://');
  }
  if (url.username || url.password) {
    throw new ServerCheckError('O endereço não pode conter usuário ou senha');
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new ServerCheckError('Sem TLS (http://) só é aceito para localhost. Use https://');
  }
  return url.origin;
}

// O LiveKit informado pelo backend segue a mesma regra de TLS: senão a CSP o liberaria, mas o Chromium
// bloquearia a conexão como conteúdo misto, com um erro bem menos claro na hora de entrar na voz.
function normalizeLiveKitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerCheckError(`O servidor informou um endereço de mídia inválido (${raw})`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ServerCheckError(
      `O servidor informou um endereço de mídia que não é WebSocket (${raw})`,
    );
  }
  if (url.protocol === 'ws:' && !isLocalHost(url.hostname)) {
    throw new ServerCheckError(
      `O servidor informou um endereço de mídia sem TLS (${raw}). Configure LIVEKIT_PUBLIC_URL com wss://`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

// Confere que o endereço é mesmo um backend deste app (GET /health) e descobre o LiveKit que ele usa.
// Roda no processo principal: o renderer não alcançaria um servidor que ainda não está na CSP.
export async function checkServer(
  input: string,
): Promise<{ [K in keyof ServerSettings]: NonNullable<ServerSettings[K]> }> {
  const serverUrl = normalizeServerUrl(input);
  let response: Response;
  try {
    response = await net.fetch(`${serverUrl}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ServerCheckError(
        `O servidor não respondeu em ${HEALTH_TIMEOUT_MS / 1000} s (${serverUrl})`,
      );
    }
    throw new ServerCheckError(
      `Não foi possível conectar a ${serverUrl}. Confira o endereço e a rede`,
    );
  }
  if (!response.ok) {
    throw new ServerCheckError(
      `O endereço respondeu, mas não é o servidor do app (HTTP ${response.status} em /health)`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ServerCheckError('O endereço respondeu, mas não é o servidor do app');
  }
  const parsed = healthSchema.safeParse(body);
  if (!parsed.success) {
    throw new ServerCheckError(
      'O servidor respondeu em /health sem o endereço do LiveKit: ele pode estar desatualizado',
    );
  }
  return { serverUrl, liveKitUrl: normalizeLiveKitUrl(parsed.data.livekitUrl) };
}
