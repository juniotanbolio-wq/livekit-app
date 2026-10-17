import { useMemo } from 'react';
import { useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { usePresence } from '../../stores/presence';
import { useVoice } from '../../stores/voice';

export function useLiveChannelIds(): Set<string> {
  const presence = usePresence((state) => state.byChannel);
  const voiceChannelId = useVoice((state) =>
    state.connection === 'connected' || state.connection === 'reconnecting'
      ? state.channelId
      : null,
  );
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const voiceRoomLive = screenTracks.length > 0;

  return useMemo(() => {
    const live = new Set<string>();
    for (const [channelId, participants] of Object.entries(presence)) {
      if (channelId !== voiceChannelId && participants.some((item) => item.isScreenSharing)) {
        live.add(channelId);
      }
    }
    if (voiceChannelId && voiceRoomLive) {
      live.add(voiceChannelId);
    }
    return live;
  }, [presence, voiceChannelId, voiceRoomLive]);
}
