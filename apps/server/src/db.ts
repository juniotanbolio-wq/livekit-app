import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.js';
import { loadConfig } from './config.js';

export function createPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: loadConfig().DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();
