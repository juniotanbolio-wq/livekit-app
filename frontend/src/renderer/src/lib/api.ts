import { apiErrorSchema } from '../../../api/types';
import type { z } from 'zod';

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

type UnauthorizedHandler = () => void;

let serverUrl: string | null = null;
let authToken: string | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export async function initApi(): Promise<string> {
  if (!serverUrl) {
    const config = await window.desktop.getConfig();
    serverUrl = config.serverUrl;
  }
  return serverUrl;
}

export function getServerUrl(): string {
  if (!serverUrl) {
    throw new Error('API não inicializada');
  }
  return serverUrl;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

interface RequestOptions<T extends z.ZodType> {
  method?: 'GET' | 'POST';
  body?: unknown;
  schema: T;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
}

export async function request<T extends z.ZodType>(
  path: string,
  { method = 'GET', body, schema, auth = true, query }: RequestOptions<T>,
): Promise<z.output<T>> {
  const url = new URL(`${getServerUrl()}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (auth && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Não foi possível conectar ao servidor (${getServerUrl()})`);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    const message = parsedError.success
      ? parsedError.data.error
      : `Erro inesperado do servidor (${response.status})`;
    if (response.status === 401 && auth) {
      unauthorizedHandler?.();
    }
    throw new ApiError(
      response.status,
      message,
      parsedError.success ? parsedError.data.details : undefined,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(response.status, 'Resposta inválida do servidor');
  }
  return parsed.data;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) {
    return err.message;
  }
  return 'Erro inesperado';
}
