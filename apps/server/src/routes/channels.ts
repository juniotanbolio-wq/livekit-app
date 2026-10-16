import { Router } from 'express';
import {
  idSchema,
  messageHistoryQuerySchema,
  type ChannelListResponse,
  type MessageHistoryResponse,
} from '@livekit-app/shared';
import { requireAuth } from '../auth/middleware.js';
import { parse } from '../http/validate.js';
import { listChannels } from '../services/channels.js';
import { listMessages } from '../services/messages.js';

export const channelsRouter = Router();

channelsRouter.use(requireAuth);

channelsRouter.get('/', async (_req, res) => {
  const response: ChannelListResponse = { channels: await listChannels() };
  res.json(response);
});

channelsRouter.get('/:id/messages', async (req, res) => {
  const channelId = parse(idSchema, req.params.id);
  const query = parse(messageHistoryQuerySchema, req.query);
  const response: MessageHistoryResponse = await listMessages(channelId, query);
  res.json(response);
});
