import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  loginRequestSchema,
  registerRequestSchema,
  type ApiError,
  type AuthResponse,
} from '@livekit-app/shared';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signUserToken } from '../auth/jwt.js';
import { toUserDto } from '../auth/users.js';

const rateLimitBody: ApiError = { error: 'Muitas tentativas, tente novamente mais tarde' };

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: rateLimitBody,
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = parse(registerRequestSchema, req.body);
  const passwordHash = await hashPassword(body.password);
  try {
    const user = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const consumed = await tx.inviteCode.updateMany({
        where: { code: body.inviteCode, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new HttpError(400, 'Código de convite inválido, expirado ou já utilizado');
      }
      const created = await tx.user.create({
        data: { username: body.username, passwordHash },
      });
      await tx.inviteCode.update({
        where: { code: body.inviteCode },
        data: { usedById: created.id },
      });
      return created;
    });
    const response: AuthResponse = { token: signUserToken(user.id), user: toUserDto(user) };
    res.status(201).json(response);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'Nome de usuário já está em uso');
    }
    throw err;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = parse(loginRequestSchema, req.body);
  const user = await prisma.user.findUnique({ where: { username: body.username } });
  if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
    throw new HttpError(401, 'Usuário ou senha inválidos');
  }
  const response: AuthResponse = { token: signUserToken(user.id), user: toUserDto(user) };
  res.json(response);
});
