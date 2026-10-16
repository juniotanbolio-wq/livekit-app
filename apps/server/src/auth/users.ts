import type { User } from '@livekit-app/shared';
import type { User as DbUser } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { verifyUserToken } from './jwt.js';

export function toUserDto(user: DbUser): User {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function findUserByToken(token: string): Promise<DbUser | null> {
  const userId = verifyUserToken(token);
  if (!userId) {
    return null;
  }
  return prisma.user.findUnique({ where: { id: userId } });
}
