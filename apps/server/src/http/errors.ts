import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiError } from '@livekit-app/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ApiError = { error: 'Rota não encontrada' };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof HttpError) {
    const body: ApiError =
      err.details === undefined
        ? { error: err.message }
        : { error: err.message, details: err.details };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    const body: ApiError = { error: 'JSON inválido' };
    res.status(400).json(body);
    return;
  }
  console.error(err);
  const body: ApiError = { error: 'Erro interno do servidor' };
  res.status(500).json(body);
};
