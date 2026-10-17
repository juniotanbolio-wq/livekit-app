import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { MicOffIcon } from '../../components/Icons';

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

export function VoiceGrid() {
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className={`grid gap-3 ${gridColumns(tracks.length)}`}>
        {tracks.map((trackRef) => (
          <Tile key={`${trackRef.participant.identity}:${trackRef.source}`} trackRef={trackRef} />
        ))}
      </div>
    </div>
  );
}
