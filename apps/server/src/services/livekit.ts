import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import type { LiveKitRole, LiveKitTokenResponse } from '@livekit-app/shared';
import { loadConfig } from '../config.js';

export function roomNameForChannel(channelId: string): string {
  return `channel-${channelId}`;
}

function grantFor(role: LiveKitRole, room: string): VideoGrant {
  if (role === 'spectator') {
    return {
      roomJoin: true,
      room,
      hidden: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
    };
  }
  return {
    roomJoin: true,
    room,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
}

export async function createLiveKitToken(
  user: { id: string; username: string },
  channelId: string,
  role: LiveKitRole,
): Promise<LiveKitTokenResponse> {
  const config = loadConfig();
  const roomName = roomNameForChannel(channelId);
  const accessToken = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: role === 'spectator' ? `${user.id}#spectator` : user.id,
    name: user.username,
    ttl: config.LIVEKIT_TOKEN_TTL,
    metadata: JSON.stringify({ userId: user.id, role }),
  });
  accessToken.addGrant(grantFor(role, roomName));
  return { token: await accessToken.toJwt(), url: config.LIVEKIT_URL, roomName };
}
