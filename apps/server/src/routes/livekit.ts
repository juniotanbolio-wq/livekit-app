import { Router, type Response } from 'express';
import { liveKitTokenRequestSchema, type LiveKitTokenResponse } from '@livekit-app/shared';
import { requireAuth, type AuthLocals } from '../auth/middleware.js';
import { parse } from '../http/validate.js';
import { getChannelOfType } from '../services/channels.js';
import { createLiveKitToken } from '../services/livekit.js';

export const liveKitRouter = Router();

liveKitRouter.use(requireAuth);

liveKitRouter.post('/token', async (req, res: Response<LiveKitTokenResponse, AuthLocals>) => {
  const body = parse(liveKitTokenRequestSchema, req.body);
  const channel = await getChannelOfType(body.channelId, 'voice');
  res.json(await createLiveKitToken(res.locals.user, channel.id, body.role));
});
