import { useEffect, useRef, useState } from 'react';
import { ConnectionState, Track, type LocalAudioTrack, type Room } from 'livekit-client';
import type { DiagnosticsInfo } from '../../../../shared/desktop-api';
import {
  StatsMeter,
  readInbound,
  readOutboundAudio,
  readOutboundVideo,
  type InboundStats,
  type OutboundAudio,
  type OutboundVideo,
} from '../../lib/rtc-stats';
import { useChannels } from '../../stores/channels';
import { getLocalScreenTracks, useScreenShare } from '../../stores/screen-share';
import { useVoice } from '../../stores/voice';
import { useWatch } from '../../stores/watch';
import { VoiceProcessor } from '../../voice/audio-processing';
import { XIcon } from '../../components/Icons';

// Painel de depuração (Ctrl+Shift+D): mostra o que o WebRTC realmente está fazendo, para medir qualidade
// (docs/medicoes.md). Os scripts de aceite e de medição leem o JSON em data-debug-json em vez de raspar o texto.
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

// Processamento pedido ao navegador e o que ele de fato aplicou (getSettings da trilha original).
interface AudioProcessing {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  voiceIsolation: boolean | null;
  channelCount: number | null;
  sampleRate: number | null;
}

interface AudioSnapshot {
  muted: boolean;
  processor: string | null;
  // Só com o processador local (RNNoise/gate): níveis em dBFS antes e depois do gate, e se o WebRTC está
  // enviando a trilha processada (e não o microfone cru).
  inputDb: number | null;
  outputDb: number | null;
  // Canal 0 da saída: igual a outputDb numa saída mono; 6 dB acima se um canal estiver vazio (defeito de canais).
  firstChannelDb: number | null;
  sendingProcessed: boolean | null;
  processing: AudioProcessing;
  outbound: OutboundAudio | null;
}

interface ScreenSnapshot {
  codecSetting: string;
  activeCodec: string | null;
  decision: string | null;
  requested: CaptureSettings;
  outbound: OutboundVideo | null;
}

interface ConnectionSnapshot {
  state: string;
  channelName: string | null;
  local: { source: string; kind: string; muted: boolean }[];
  mic: AudioSnapshot | null;
  screen: ScreenSnapshot | null;
  screenAudio: AudioSnapshot | null;
  remote: RemotePublicationRow[];
}

interface Snapshot {
  system: DiagnosticsInfo | null;
  voice: ConnectionSnapshot | null;
  spectator: ConnectionSnapshot | null;
}

function processingOf(track: LocalAudioTrack): AudioProcessing {
  // getSourceTrackSettings lê a trilha capturada, antes de qualquer processador (RNNoise/gate).
  const settings = track.getSourceTrackSettings() as MediaTrackSettings & {
    voiceIsolation?: boolean;
  };
  return {
    echoCancellation:
      typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
    noiseSuppression:
      typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
    autoGainControl:
      typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
    voiceIsolation: typeof settings.voiceIsolation === 'boolean' ? settings.voiceIsolation : null,
    channelCount: settings.channelCount ?? null,
    sampleRate: settings.sampleRate ?? null,
  };
}

async function snapshotAudio(
  track: LocalAudioTrack,
  muted: boolean,
  meter: StatsMeter,
): Promise<AudioSnapshot> {
  const processor = track.getProcessor();
  const local = processor instanceof VoiceProcessor ? processor : null;
  const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    muted,
    processor: processor?.name ?? null,
    inputDb: round(local?.levelDb() ?? null),
    outputDb: round(local?.outputLevelDb() ?? null),
    firstChannelDb: round(local?.firstChannelLevelDb() ?? null),
    sendingProcessed: local ? track.sender?.track === local.processedTrack : null,
    processing: processingOf(track),
    outbound: await readOutboundAudio(track, meter).catch(() => null),
  };
}

async function snapshotRoom(
  room: Room,
  channelName: string | null,
  meter: StatsMeter,
  withLocalScreen: boolean,
): Promise<ConnectionSnapshot> {
  const local = [...room.localParticipant.trackPublications.values()].map((publication) => ({
    source: publication.source,
    kind: publication.kind,
    muted: publication.isMuted,
  }));

  const micPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const micTrack = micPublication?.audioTrack;
  const mic =
    micTrack && micPublication
      ? await snapshotAudio(micTrack, micPublication.isMuted, meter)
      : null;

  let screen: ScreenSnapshot | null = null;
  let screenAudio: AudioSnapshot | null = null;
  const tracks = withLocalScreen ? getLocalScreenTracks() : { video: null, audio: null };
  if (tracks.video) {
    const settings = tracks.video.mediaStreamTrack.getSettings();
    const share = useScreenShare.getState();
    screen = {
      codecSetting: share.codec,
      activeCodec: share.activeCodec,
      decision: share.decision,
      requested: {
        width: settings.width ?? null,
        height: settings.height ?? null,
        fps: settings.frameRate ? Math.round(settings.frameRate) : null,
      },
      outbound: await readOutboundVideo(tracks.video, meter).catch(() => null),
    };
  }
  if (tracks.audio) {
    screenAudio = await snapshotAudio(tracks.audio, false, meter);
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

  return { state: room.state, channelName, local, mic, screen, screenAudio, remote };
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

function formatBool(value: boolean | null, yes = 'sim', no = 'não'): string {
  return value === null ? '-' : value ? yes : no;
}

function AudioLine({ label, audio }: { label: string; audio: AudioSnapshot }) {
  const { processing, outbound } = audio;
  return (
    <p data-debug-audio={label}>
      {label}: {formatBitrate(outbound?.bitrateKbps ?? null)} · {outbound?.codec ?? '-'} · máx{' '}
      {formatValue(outbound?.maxBitrateKbps ?? null, ' kbps')}
      {audio.muted ? ' · mudo' : ''} · RED {outbound ? (outbound.redActive ? 'ativo' : 'não') : '-'}
      <br />
      eco {formatBool(processing.echoCancellation)} · ruído{' '}
      {formatBool(processing.noiseSuppression)} · ganho {formatBool(processing.autoGainControl)} ·
      isolamento {formatBool(processing.voiceIsolation)} · {formatValue(processing.channelCount)}{' '}
      canal(is) · processador {audio.processor ?? 'nenhum'}
      {audio.processor
        ? ` (entrada ${formatValue(audio.inputDb, ' dB')} → saída ${formatValue(audio.outputDb, ' dB')}, enviando ${formatBool(audio.sendingProcessed, 'processado', 'CRU')})`
        : ''}
    </p>
  );
}

function ScreenSection({ screen }: { screen: ScreenSnapshot }) {
  const { outbound, requested } = screen;
  return (
    <>
      <p data-debug-capture>
        captura: pedida {formatValue(requested.width)}x{formatValue(requested.height)} @{' '}
        {formatValue(requested.fps)} fps · medida {formatValue(outbound?.sourceFps ?? null)} fps
      </p>
      <p data-debug-codec>
        codec: <b>{screen.activeCodec ?? '-'}</b> (config {screen.codecSetting}
        {screen.decision ? `: ${screen.decision}` : ''})
      </p>
      <p>
        degradação: {outbound?.degradationPreference ?? '-'} · upload{' '}
        {formatBitrate(outbound?.totalKbps ?? null)} de{' '}
        {formatBitrate(outbound?.availableOutgoingKbps ?? null)} estimados · RTT{' '}
        {formatValue(outbound?.rttMs ?? null, ' ms')}
      </p>
      {outbound && outbound.layers.length > 0 && (
        <table className="w-full" data-debug-outbound>
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left">camada</th>
              <th className="text-left">resolução</th>
              <th className="text-left">fps</th>
              <th className="text-left">bitrate</th>
              <th className="text-left">codec</th>
              <th className="text-left">ativa</th>
              <th className="text-left">ms/q</th>
            </tr>
          </thead>
          <tbody>
            {outbound.layers.flatMap((layer) => [
              <tr key={`${layer.rid}:a`} data-rid={layer.rid}>
                <td>{layer.rid}</td>
                <td>
                  {formatValue(layer.width)}x{formatValue(layer.height)}
                </td>
                <td>{formatValue(layer.fps)}</td>
                <td>{formatBitrate(layer.bitrateKbps)}</td>
                <td>{layer.codec ?? '-'}</td>
                <td className={layer.active === false ? 'text-amber-400' : ''}>
                  {formatBool(layer.active)}
                </td>
                <td>{formatValue(layer.msPerFrame)}</td>
              </tr>,
              <tr key={`${layer.rid}:b`} className="text-zinc-400">
                <td />
                <td colSpan={6} className="pb-1">
                  {layer.encoder ?? '-'} ·{' '}
                  <span className={layer.powerEfficient ? 'text-emerald-400' : 'text-amber-400'}>
                    {formatBool(layer.powerEfficient, 'hardware', 'software')}
                  </span>{' '}
                  · limitação {layer.limitation ?? '-'}
                  {layer.scalabilityMode ? ` · ${layer.scalabilityMode}` : ''}
                </td>
              </tr>,
            ])}
          </tbody>
        </table>
      )}
    </>
  );
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
          {snapshot.mic && <AudioLine label="microfone" audio={snapshot.mic} />}
          {snapshot.screen && <ScreenSection screen={snapshot.screen} />}
          {snapshot.screenAudio && <AudioLine label="áudio da tela" audio={snapshot.screenAudio} />}
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
                  ? ` · decoder ${row.inbound.decoder ?? '-'} (${formatBool(row.inbound.powerEfficientDecoder, 'hardware', 'software')}) · perdidos ${formatValue(row.inbound.packetsLost)} · descartados ${formatValue(row.inbound.framesDropped)} · congelamentos ${formatValue(row.inbound.freezeCount)} · jitter ${formatValue(row.inbound.jitterMs, ' ms')}`
                  : ''}
              </p>
            ))}
        </>
      )}
    </section>
  );
}

function SystemSection({ system }: { system: DiagnosticsInfo | null }) {
  if (!system) {
    return null;
  }
  // getAppMetrics dá % da CPU inteira; convertido também em núcleos, que é mais fácil de comparar entre PCs.
  const threads = navigator.hardwareConcurrency || 1;
  const cpu = (type: string) => {
    const percent = system.processes
      .filter((item) => item.type === type)
      .reduce((sum, item) => sum + item.cpuPercent, 0);
    return `${percent.toFixed(1)}% (${((percent * threads) / 100).toFixed(2)} núcleo)`;
  };
  return (
    <section className="space-y-1" data-debug-section="Sistema">
      <h3 className="text-xs font-bold tracking-wide text-zinc-300 uppercase">Sistema</h3>
      <p>
        Electron {system.electron} · Chromium {system.chrome} · codificação de vídeo:{' '}
        <b>{system.gpuFeatures['video_encode'] ?? '-'}</b>
      </p>
      {system.gpus.map((gpu, index) => (
        <p key={index}>
          GPU{gpu.active ? ' (ativa)' : ''}: {gpu.name ?? '-'} · 0x{gpu.vendorId.toString(16)}:0x
          {gpu.deviceId.toString(16)} · driver {gpu.driverVersion ?? '-'}
        </p>
      ))}
      <p>
        features:{' '}
        {system.enabledFeatures.length > 0 ? system.enabledFeatures.join(', ') : 'nenhuma'}
      </p>
      <p>
        CPU ({threads} threads): página {cpu('Tab')} · GPU {cpu('GPU')} · principal {cpu('Browser')}
      </p>
    </section>
  );
}

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    system: null,
    voice: null,
    spectator: null,
  });
  const meterRef = useRef(new StatsMeter());

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
    let running = false;
    const tick = async () => {
      // Leituras lentas não se acumulam: se a anterior ainda não terminou, pula esta.
      if (running) {
        return;
      }
      running = true;
      try {
        const channels = useChannels.getState().channels;
        const nameOf = (id: string | null) =>
          channels.find((channel) => channel.id === id)?.name ?? null;
        const voice = useVoice.getState();
        const watch = useWatch.getState();
        const meter = meterRef.current;
        const next: Snapshot = {
          system: await window.desktop.getDiagnostics().catch(() => null),
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
      } finally {
        running = false;
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
      data-debug-json={JSON.stringify(snapshot)}
      className="fixed top-14 right-3 z-40 max-h-[85vh] w-[600px] max-w-[calc(100vw-1.5rem)] space-y-4 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/95 p-3 font-mono text-[11px] text-zinc-200 shadow-2xl"
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
      <SystemSection system={snapshot.system} />
      <Section title="Voz" snapshot={snapshot.voice} />
      <Section title="Espectador" snapshot={snapshot.spectator} />
    </div>
  );
}
