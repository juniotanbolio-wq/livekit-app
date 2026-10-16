import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { prisma } from '../db.js';

const hoursSchema = z.coerce.number().int().min(1).max(8760);

async function createInvite(): Promise<void> {
  const { values } = parseArgs({
    options: { hours: { type: 'string', short: 'h' } },
    strict: true,
  });
  const hours = hoursSchema.parse(values.hours ?? loadConfig().INVITE_TTL_HOURS);
  const code = randomBytes(12).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await prisma.inviteCode.create({ data: { code, expiresAt } });
  console.log(`Código de convite: ${code}`);
  console.log(`Válido até: ${expiresAt.toLocaleString('pt-BR')} (${hours}h, uso único)`);
}

try {
  await createInvite();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
