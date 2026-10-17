import { RoomServiceClient, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import {
  SPECTATOR_IDENTITY_SUFFIX,
  type PresenceParticipant,
  type PresenceResponse,
} from '@livekit-app/shared';
import { loadConfig } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { roomNameForChannel } from './livekit.js';

let client: RoomServiceClient | undefined;
let cache: { expiresAt: number; value: PresenceResponse } | undefined;
let inFlight: Promise<PresenceResponse> | undefined;

function roomService(): RoomServiceClient {
  if (!client) {
    const config = loadConfig();
    client = new RoomServiceClient(
      config.LIVEKIT_URL,
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    );
  }
  return client;
}

function isVisible(participant: ParticipantInfo): boolean {
  if (participant.permission?.hidden) {
    return false;
  }
  return !participant.identity.endsWith(SPECTATOR_IDENTITY_SUFFIX);
}

function toPresenceParticipant(participant: ParticipantInfo): PresenceParticipant {
  return {
    userId: participant.identity,
    username: participant.name || participant.identity,
    isScreenSharing: participant.tracks.some(
      (track) => track.source === TrackSource.SCREEN_SHARE && !track.muted,
    ),
  };
}

async function fetchPresence(): Promise<PresenceResponse> {
  const voiceChannels = await prisma.channel.findMany({
    where: { type: 'voice' },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  const service = roomService();
  const roomNames = voiceChannels.map((channel) => roomNameForChannel(channel.id));
  let activeRooms: Set<string>;
  try {
    const rooms = await service.listRooms(roomNames);
    activeRooms = new Set(
      rooms.filter((room) => room.numParticipants > 0).map((room) => room.name),
    );
  } catch (err) {
    console.error('Falha ao consultar salas no LiveKit:', err);
    throw new HttpError(503, 'Servidor de mídia indisponível');
  }
  const channels = await Promise.all(
    voiceChannels.map(async (channel) => {
      const roomName = roomNameForChannel(channel.id);
      if (!activeRooms.has(roomName)) {
        return { channelId: channel.id, participants: [] };
      }
      try {
        const participants = await service.listParticipants(roomName);
        return {
          channelId: channel.id,
          participants: participants.filter(isVisible).map(toPresenceParticipant),
        };
      } catch (err) {
        console.error(`Falha ao listar participantes de ${roomName}:`, err);
        return { channelId: channel.id, participants: [] };
      }
    }),
  );
  return { channels };
}

export async function getPresence(): Promise<PresenceResponse> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  if (!inFlight) {
    inFlight = fetchPresence()
      .then((value) => {
        cache = { expiresAt: Date.now() + loadConfig().PRESENCE_CACHE_MS, value };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
