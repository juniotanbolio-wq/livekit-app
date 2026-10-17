import { isTrackReference, useTracks, VideoTrack } from '@livekit/components-react';
import { Track, type Room } from 'livekit-client';
import { Spinner } from '../../components/Icons';

export function StreamPlayer({
  room,
  identity,
  placeholder,
}: {
  room: Room;
  identity: string | null;
  placeholder: string;
}) {
  const tracks = useTracks([Track.Source.ScreenShare], { room, onlySubscribed: false });
  const trackRef = tracks.find((item) => item.participant.identity === identity);

  if (!identity || !trackRef) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        {placeholder}
      </div>
    );
  }

  if (!isTrackReference(trackRef) || !trackRef.publication.track) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
        <Spinner size={20} /> Carregando transmissão...
      </div>
    );
  }

  return (
    <VideoTrack
      trackRef={trackRef}
      data-stream-identity={identity}
      className="h-full w-full bg-black object-contain"
    />
  );
}
