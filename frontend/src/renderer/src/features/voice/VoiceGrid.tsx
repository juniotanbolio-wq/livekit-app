import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { LiveBadge, MicOffIcon } from '../../components/Icons';
import { useWatch } from '../../stores/watch';

function gridColumns(count: number): string {
  if (count <= 1) {
    return 'grid-cols-1';
  }
  if (count <= 4) {
    return 'grid-cols-2';
  }
  if (count <= 9) {
    return 'grid-cols-3';
  }
  return 'grid-cols-4';
}

function Tile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const { participant } = trackRef;
  const speaking = useIsSpeaking(participant);
  const cameraMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const name = participant.name || participant.identity;
  const showVideo = isTrackReference(trackRef) && !cameraMuted;

  return (
    <div
      data-tile="camera"
      data-identity={participant.identity}
      className={`relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-900 ring-2 transition-shadow ${
        speaking ? 'ring-emerald-400' : 'ring-transparent'
      }`}
    >
      {showVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className={`h-full w-full object-cover ${participant.isLocal ? '-scale-x-100' : ''}`}
        />
      ) : (
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 text-3xl font-semibold text-white uppercase">
          {name.slice(0, 1)}
        </span>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {micMuted && <MicOffIcon size={12} className="text-red-400" />}
        <span>
          {name}
          {participant.isLocal ? ' (você)' : ''}
        </span>
      </div>
    </div>
  );
}

function ScreenTile({
  trackRef,
  channelId,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  channelId: string;
}) {
  const watch = useWatch((state) => state.watch);
  const { participant } = trackRef;
  const name = participant.name || participant.identity;
  const isLocal = participant.isLocal;

  return (
    <button
      type="button"
      data-tile="screen"
      data-identity={participant.identity}
      disabled={isLocal}
      title={isLocal ? 'Sua tela' : `Assistir à tela de ${name}`}
      onClick={() => watch(channelId, participant.identity)}
      className="group relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded-lg bg-black ring-2 ring-red-500/70 enabled:hover:ring-red-400"
    >
      {isTrackReference(trackRef) ? (
        <VideoTrack trackRef={trackRef} className="h-full w-full object-contain" />
      ) : null}
      <div className="absolute top-2 left-2">
        <LiveBadge />
      </div>
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {isLocal ? 'Sua tela' : `Tela de ${name}`}
      </div>
      {!isLocal && (
        <div className="absolute inset-0 hidden items-center justify-center bg-black/40 text-sm font-medium text-white group-hover:flex">
          Assistir em tela grande
        </div>
      )}
    </button>
  );
}

export function VoiceGrid({ channelId }: { channelId: string }) {
  const cameras = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const screens = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const total = cameras.length + screens.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className={`grid gap-3 ${gridColumns(total)}`}>
        {screens.map((trackRef) => (
          <ScreenTile
            key={`${trackRef.participant.identity}:${trackRef.source}`}
            trackRef={trackRef}
            channelId={channelId}
          />
        ))}
        {cameras.map((trackRef) => (
          <Tile key={`${trackRef.participant.identity}:${trackRef.source}`} trackRef={trackRef} />
        ))}
      </div>
    </div>
  );
}
