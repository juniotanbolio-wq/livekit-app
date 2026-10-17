import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from '../../../generated/api';
import { isRecord, isString } from './guards';

// Tipos do contrato (contracts/openapi.yaml), gerados por `npm run generate`.
export type Schemas = components['schemas'];
export type User = Schemas['User'];
export type Channel = Schemas['Channel'];
export type AuthResponse = Schemas['AuthResponse'];
export type LoginRequest = Schemas['LoginRequest'];
export type RegisterRequest = Schemas['RegisterRequest'];
export type LiveKitRole = Schemas['LiveKitRole'];
export type LiveKitTokenResponse = Schemas['LiveKitTokenResponse'];
export type PresenceParticipant = Schemas['PresenceParticipant'];
export type ChannelPresence = Schemas['ChannelPresence'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiClient = ReturnType<typeof createClient<paths>>;

// Rotas sem `security` no contrato: não levam o token e um 401 nelas (senha errada) não é sessão expirada.
const PUBLIC_PATHS: ReadonlySet<string> = new Set<keyof paths>([
  '/health',
  '/api/auth/login',
  '/api/auth/register',
]);

let client: ApiClient | null = null;
let endpoints: { serverUrl: string; liveKitUrl: string } | null = null;
let authToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

const authMiddleware: Middleware = {
  onRequest({ request, schemaPath }) {
    if (authToken && !PUBLIC_PATHS.has(schemaPath)) {
      request.headers.set('Authorization', `Bearer ${authToken}`);
    }
    return request;
  },
  onResponse({ request, response }) {
    // 401 numa chamada autenticada = token expirado ou revogado: a sessão acaba e o app volta ao login.
    if (response.status === 401 && request.headers.has('Authorization')) {
      unauthorizedHandler?.();
    }
    return response;
  },
};

// O endereço do servidor e o do LiveKit vêm do processo principal (validados por GET /health) e são os
// mesmos que a CSP desta página libera.
export function initApi(serverUrl: string, liveKitUrl: string): void {
  endpoints = { serverUrl, liveKitUrl };
  client = createClient<paths>({ baseUrl: serverUrl });
  client.use(authMiddleware);
}

export function getServerUrl(): string {
  if (!endpoints) {
    throw new Error('API não inicializada');
  }
  return endpoints.serverUrl;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

function toApiError(response: Response, error: unknown): ApiError {
  if (isRecord(error) && isString(error['error'])) {
    return new ApiError(response.status, error['error'], error['details']);
  }
  return new ApiError(response.status, `Erro inesperado do servidor (${response.status})`);
}

async function call<T>(
  run: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  if (!client) {
    throw new Error('API não inicializada');
  }
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await run(client);
  } catch {
    throw new ApiError(0, `Não foi possível conectar ao servidor (${getServerUrl()})`);
  }
  if (result.response.ok && result.data !== undefined) {
    return result.data;
  }
  throw toApiError(result.response, result.error);
}

export function login(body: LoginRequest): Promise<AuthResponse> {
  return call((api) => api.POST('/api/auth/login', { body }));
}

export function register(body: RegisterRequest): Promise<AuthResponse> {
  return call((api) => api.POST('/api/auth/register', { body }));
}

export async function listChannels(): Promise<Channel[]> {
  const { channels } = await call((api) => api.GET('/api/channels'));
  return channels;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

// Token de acesso à sala LiveKit do canal. A URL do LiveKit é a devolvida pelo backend; se ela não for a
// mesma que a CSP libera (o servidor mudou LIVEKIT_PUBLIC_URL depois que este app o validou), a conexão
// seria bloqueada sem explicação. Melhor avisar o que fazer.
export async function createLiveKitToken(
  channelId: string,
  role: LiveKitRole,
): Promise<LiveKitTokenResponse> {
  const token = await call((api) => api.POST('/api/livekit/token', { body: { channelId, role } }));
  const expected = endpoints ? originOf(endpoints.liveKitUrl) : null;
  if (!expected || originOf(token.url) !== expected) {
    throw new ApiError(
      0,
      `O servidor passou a usar outro endereço de mídia (${token.url}). Abra Configurações > Servidor e salve o endereço de novo para atualizar.`,
    );
  }
  return token;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return 'Erro inesperado';
}
