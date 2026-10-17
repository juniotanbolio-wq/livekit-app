import { useEffect, useRef, useState } from 'react';
import { ConnectionState, Track, type Room } from 'livekit-client';
import {
  BitrateMeter,
  readInbound,
  readOutboundVideo,
  type InboundStats,
  type OutboundVideoLayer,
} from '../../lib/rtc-stats';
import { useChannels } from '../../stores/channels';
import { getLocalScreenTracks } from '../../stores/screen-share';
import { useVoice } from '../../stores/voice';
import { useWatch } from '../../stores/watch';
import { XIcon } from '../../components/Icons';

const REFRESH_MS = 1000;

interface RemotePublicationRow {
  participant: string;
  source: string;
  kind: string;
  subscribed: boolean;
  inbound: InboundStats | null;
}

interface CaptureSettings {
  width: number | null;
  height: number | null;
  fps: number | null;
}

interface ConnectionSnapshot {
  state: string;
  channelName: string | null;
  local: { source: string; kind: string; muted: boolean }[];
  capture: CaptureSettings | null;
  outbound: OutboundVideoLayer[];
  remote: RemotePublicationRow[];
}

interface Snapshot {
  voice: ConnectionSnapshot | null;
  spectator: ConnectionSnapshot | null;
}

async function snapshotRoom(
  room: Room,
  channelName: string | null,
  meter: BitrateMeter,
  withLocalScreen: boolean,
): Promise<ConnectionSnapshot> {
  const local = [...room.localParticipant.trackPublications.values()].map((publication) => ({
    source: publication.source,
    kind: publication.kind,
    muted: publication.isMuted,
  }));

  let capture: CaptureSettings | null = null;
  let outbound: OutboundVideoLayer[] = [];
  const screen = withLocalScreen ? getLocalScreenTracks().video : null;
  if (screen) {
    const settings = screen.mediaStreamTrack.getSettings();
    capture = {
      width: settings.width ?? null,
      height: settings.height ?? null,
      fps: settings.frameRate ? Math.round(settings.frameRate) : null,
    };
    outbound = await readOutboundVideo(screen, meter).catch(() => []);
  }

  const remote: RemotePublicationRow[] = [];
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const wantsStats =
        publication.isSubscribed &&
        publication.track &&
        (publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio);
      remote.push({
        participant: participant.name || participant.identity,
        source: publication.source,
        kind: publication.kind,
        subscribed: publication.isSubscribed,
        inbound:
          wantsStats && publication.track
            ? await readInbound(publication.track, meter).catch(() => null)
            : null,
      });
    }
  }

  return {
    state: room.state,
    channelName,
    local,
    capture,
    outbound,
    remote,
  };
}

function formatValue(value: number | null, suffix = ''): string {
  return value === null ? '-' : `${value}${suffix}`;
}

function formatBitrate(kbps: number | null): string {
  if (kbps === null) {
    return '-';
  }
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps} kbps`;
}

function Section({ title, snapshot }: { title: string; snapshot: ConnectionSnapshot | null }) {
  return (
    <section className="space-y-2" data-debug-section={title}>
      <h3 className="text-xs font-bold tracking-wide text-zinc-300 uppercase">{title}</h3>
      {!snapshot || snapshot.state === ConnectionState.Disconnected ? (
        <p className="text-zinc-500" data-debug-state="disconnected">
          sem conexão
        </p>
      ) : (
        <>
          <p data-debug-state={snapshot.state}>
            estado: <b>{snapshot.state}</b> · canal: <b>{snapshot.channelName ?? '-'}</b>
          </p>
          {snapshot.local.length > 0 && (
            <p>
              publicando:{' '}
              {snapshot.local
                .map((item) => `${item.source}${item.muted ? ' (mudo)' : ''}`)
                .join(', ')}
            </p>
          )}
          {snapshot.capture && (
            <p data-debug-capture>
              captura: {formatValue(snapshot.capture.width)}x{formatValue(snapshot.capture.height)}{' '}
              @ {formatValue(snapshot.capture.fps)} fps
            </p>
          )}
          {snapshot.outbound.length > 0 && (
            <table className="w-full" data-debug-outbound>
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left">camada</th>
                  <th className="text-left">resolução</th>
                  <th className="text-left">fps</th>
                  <th className="text-left">bitrate</th>
                  <th className="text-left">codec</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.outbound.map((layer) => (
                  <tr key={layer.rid} data-rid={layer.rid}>
                    <td>{layer.rid}</td>
                    <td>
                      {formatValue(layer.width)}x{formatValue(layer.height)}
                    </td>
                    <td>{formatValue(layer.fps)}</td>
                    <td>{formatBitrate(layer.bitrateKbps)}</td>
                    <td>{layer.codec ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {snapshot.outbound[0] && (
            <p className="text-zinc-500">
              encoder: {snapshot.outbound[0].encoder ?? '-'} · limitação:{' '}
              {snapshot.outbound[0].limitation ?? '-'}
            </p>
          )}
          <table className="w-full" data-debug-remote>
            <thead className="text-zinc-500">
              <tr>
                <th className="text-left">participante</th>
                <th className="text-left">fonte</th>
                <th className="text-left">assinada</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.remote.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-zinc-500">
                    nenhuma trilha remota publicada
                  </td>
                </tr>
              )}
              {snapshot.remote.map((row, index) => (
                <tr
                  key={`${row.participant}:${row.source}:${index}`}
                  data-source={row.source}
                  data-subscribed={row.subscribed}
                >
                  <td className="max-w-28 truncate">{row.participant}</td>
                  <td>
                    {row.source} ({row.kind})
                  </td>
                  <td className={row.subscribed ? 'text-emerald-400' : 'text-zinc-500'}>
                    {row.subscribed ? 'sim' : 'não'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {snapshot.remote
            .filter((row) => row.inbound)
            .map((row, index) => (
              <p key={`${row.source}:${index}`} data-debug-inbound={row.source}>
                recebendo {row.source} de {row.participant}:{' '}
                {row.inbound?.kind === 'video'
                  ? `${formatValue(row.inbound.width)}x${formatValue(row.inbound.height)} @ ${formatValue(row.inbound.fps)} fps · `
                  : ''}
                {formatBitrate(row.inbound?.bitrateKbps ?? null)} · {row.inbound?.codec ?? '-'}
                {row.inbound?.kind === 'video'
                  ? ` · decoder ${row.inbound.decoder ?? '-'} · perdidos ${formatValue(row.inbound.packetsLost)} · descartados ${formatValue(row.inbound.framesDropped)} · jitter ${formatValue(row.inbound.jitterMs, ' ms')}`
                  : ''}
              </p>
            ))}
        </>
      )}
    </section>
  );
}

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({ voice: null, spectator: null });
  const meterRef = useRef(new BitrateMeter());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const channels = useChannels.getState().channels;
      const nameOf = (id: string | null) =>
        channels.find((channel) => channel.id === id)?.name ?? null;
      const voice = useVoice.getState();
      const watch = useWatch.getState();
      const meter = meterRef.current;
      const next: Snapshot = {
        voice: voice.room
          ? await snapshotRoom(voice.room, nameOf(voice.channelId), meter, true)
          : null,
        spectator: watch.room
          ? await snapshotRoom(watch.room, nameOf(watch.spectatorChannelId), meter, false)
          : null,
      };
      if (!cancelled) {
        setSnapshot(next);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      data-debug-panel
      className="fixed top-14 right-3 z-40 max-h-[80vh] w-[440px] space-y-4 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/95 p-3 font-mono text-[11px] text-zinc-200 shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold">Depuração (Ctrl+Shift+D)</span>
        <button
          type="button"
          title="Fechar depuração"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <XIcon size={14} />
        </button>
      </div>
      <Section title="Voz" snapshot={snapshot.voice} />
      <Section title="Espectador" snapshot={snapshot.spectator} />
    </div>
  );
}
