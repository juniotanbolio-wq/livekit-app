import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

function main(): void {
  const config = loadConfig();
  const server = createServer(createApp());

  server.listen(config.PORT, config.HOST, () => {
    console.log(`Servidor ouvindo em http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`Recebido ${signal}, encerrando...`);
    server.close((err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
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
