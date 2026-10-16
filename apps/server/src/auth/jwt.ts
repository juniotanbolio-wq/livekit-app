import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { loadConfig } from '../config.js';

const payloadSchema = z.object({ sub: z.string().min(1) });

export function signUserToken(userId: string): string {
  const config = loadConfig();
  return jwt.sign({}, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: config.JWT_EXPIRES_IN as NonNullable<SignOptions['expiresIn']>,
  });
}

export function verifyUserToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, loadConfig().JWT_SECRET, { algorithms: ['HS256'] });
    const parsed = payloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data.sub : null;
  } catch {
    return null;
  }
}
