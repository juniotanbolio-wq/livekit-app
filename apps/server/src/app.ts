import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsOptions } from './http/cors.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { authRouter } from './routes/auth.js';
import { channelsRouter } from './routes/channels.js';
import { liveKitRouter } from './routes/livekit.js';
import { presenceRouter } from './routes/presence.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/livekit', liveKitRouter);
  app.use('/api/presence', presenceRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
