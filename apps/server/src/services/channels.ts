import { channelTypeSchema, type Channel, type ChannelType } from '@livekit-app/shared';
import type { Channel as DbChannel } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';

export function toChannelDto(channel: DbChannel): Channel {
  return {
    id: channel.id,
    name: channel.name,
    type: channelTypeSchema.parse(channel.type),
    position: channel.position,
  };
}

export async function listChannels(): Promise<Channel[]> {
  const channels = await prisma.channel.findMany({ orderBy: { position: 'asc' } });
  return channels.map(toChannelDto);
}

export async function getChannelOfType(channelId: string, type: ChannelType): Promise<Channel> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    throw new HttpError(404, 'Canal não encontrado');
  }
  const dto = toChannelDto(channel);
  if (dto.type !== type) {
    throw new HttpError(400, type === 'text' ? 'Canal não é de texto' : 'Canal não é de voz');
  }
  return dto;
}
