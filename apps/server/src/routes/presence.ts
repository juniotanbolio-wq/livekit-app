import { Router } from 'express';
import type { PresenceResponse } from '@livekit-app/shared';
import { requireAuth } from '../auth/middleware.js';
import { getPresence } from '../services/presence.js';

export const presenceRouter = Router();

presenceRouter.use(requireAuth);

presenceRouter.get('/', async (_req, res) => {
  const response: PresenceResponse = await getPresence();
  res.json(response);
});
