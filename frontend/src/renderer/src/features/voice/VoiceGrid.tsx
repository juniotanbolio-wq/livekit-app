import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { EyeIcon, LiveBadge, MicOffIcon, MonitorIcon } from '../../components/Icons';
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

// Transmissão de outra pessoa: só um cartão, sem vídeo. A tela não é assinada até o clique em "Assistir"
// (stores/watch.ts); sem prévia, quem só está na voz não gasta banda nem decodifica 1080p, e o dynacast
// deixa o emissor parar de codificar quando ninguém assiste. A própria tela mostra a prévia local, que não
// passa pela rede.
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
    <div
      data-tile="screen"
      data-identity={participant.identity}
      className="relative flex aspect-video min-h-0 flex-col items-center justify-center gap-3 overflow-hidden rounded-lg bg-black ring-2 ring-red-500/70"
    >
      {isLocal && isTrackReference(trackRef) ? (
        <VideoTrack trackRef={trackRef} className="absolute inset-0 h-full w-full object-contain" />
      ) : (
        <>
          <MonitorIcon size={36} className="text-zinc-500" />
          <button
            type="button"
            data-watch-identity={participant.identity}
            title={`Assistir à tela de ${name}`}
            onClick={() => watch(channelId, participant.identity)}
            className="flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            <EyeIcon size={16} />
            Assistir
          </button>
        </>
      )}
      <div className="absolute top-2 left-2">
        <LiveBadge />
      </div>
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {isLocal ? 'Sua tela' : `Tela de ${name}`}
      </div>
    </div>
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
