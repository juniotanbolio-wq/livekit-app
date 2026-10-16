import { passwordSchema, usernameSchema, VOICE_CHANNEL_COUNT } from '@livekit-app/shared';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { prisma } from '../db.js';
import { hashPassword } from '../auth/password.js';

const adminSchema = z.object({
  SEED_ADMIN_USERNAME: usernameSchema,
  SEED_ADMIN_PASSWORD: passwordSchema,
});

const channels = [
  { position: 0, name: 'geral', type: 'text' },
  ...Array.from({ length: VOICE_CHANNEL_COUNT }, (_, index) => ({
    position: index + 1,
    name: `Voz ${index + 1}`,
    type: 'voice',
  })),
];

async function seed(): Promise<void> {
  const config = loadConfig();
  const admin = adminSchema.safeParse(config);
  if (!admin.success) {
    throw new Error(
      `Defina SEED_ADMIN_USERNAME e SEED_ADMIN_PASSWORD no .env:\n${z.prettifyError(admin.error)}`,
    );
  }

  for (const channel of channels) {
    await prisma.channel.upsert({
      where: { position: channel.position },
      create: channel,
      update: { name: channel.name, type: channel.type },
    });
  }
  console.log(`Canais garantidos: ${channels.length}`);

  const username = admin.data.SEED_ADMIN_USERNAME;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { isAdmin: true } });
    console.log(`Admin "${username}" já existia; senha mantida`);
  } else {
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(admin.data.SEED_ADMIN_PASSWORD),
        isAdmin: true,
      },
    });
    console.log(`Admin "${username}" criado`);
  }
}

try {
  await seed();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
