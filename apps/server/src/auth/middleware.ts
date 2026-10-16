import type { NextFunction, Request, Response } from 'express';
import type { User as DbUser } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { findUserByToken } from './users.js';

export type AuthLocals = { user: DbUser };

export async function requireAuth(
  req: Request,
  res: Response<unknown, AuthLocals>,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    next(new HttpError(401, 'Não autenticado'));
    return;
  }
  try {
    const user = await findUserByToken(token);
    if (!user) {
      next(new HttpError(401, 'Token inválido ou expirado'));
      return;
    }
    res.locals.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
