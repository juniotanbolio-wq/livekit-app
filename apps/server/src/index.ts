import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { prisma } from './db.js';
import { createRealtimeServer } from './realtime/socket.js';

function main(): void {
  const config = loadConfig();
  const server = createServer(createApp());
  const io = createRealtimeServer(server);

  server.listen(config.PORT, config.HOST, () => {
    console.log(`Servidor ouvindo em http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Recebido ${signal}, encerrando...`);
    setTimeout(() => process.exit(1), 10_000).unref();
    void io.close(async (err) => {
      await prisma.$disconnect();
      if (err) {
        console.error(err);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
