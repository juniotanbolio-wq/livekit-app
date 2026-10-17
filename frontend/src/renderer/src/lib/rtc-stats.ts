import type { LocalTrack, RemoteTrack } from 'livekit-client';

export interface OutboundVideoLayer {
  rid: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  encoder: string | null;
  limitation: string | null;
  active: boolean | null;
}

export interface InboundStats {
  kind: 'audio' | 'video';
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  decoder: string | null;
  framesDropped: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
}

type StatRecord = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class BitrateMeter {
  private readonly previous = new Map<string, { bytes: number; timestamp: number }>();

  kbps(key: string, bytes: number | null, timestamp: number | null): number | null {
    if (bytes === null || timestamp === null) {
      return null;
    }
    const last = this.previous.get(key);
    this.previous.set(key, { bytes, timestamp });
    if (!last || timestamp <= last.timestamp || bytes < last.bytes) {
      return null;
    }
    return Math.round(((bytes - last.bytes) * 8) / (timestamp - last.timestamp));
  }
}

function collect(report: RTCStatsReport): { stats: StatRecord[]; codecs: Map<string, string> } {
  const stats: StatRecord[] = [];
  const codecs = new Map<string, string>();
  report.forEach((value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const stat = value as StatRecord;
    stats.push(stat);
    if (stat['type'] === 'codec') {
      const id = str(stat['id']);
      const mime = str(stat['mimeType']);
      if (id && mime) {
        codecs.set(id, mime);
      }
    }
  });
  return { stats, codecs };
}

export async function readOutboundVideo(
  track: LocalTrack,
  meter: BitrateMeter,
): Promise<OutboundVideoLayer[]> {
  const report = await track.getRTCStatsReport();
  if (!report) {
    return [];
  }
  const { stats, codecs } = collect(report);
  const layers: OutboundVideoLayer[] = [];
  for (const stat of stats) {
    if (stat['type'] !== 'outbound-rtp' || stat['kind'] !== 'video') {
      continue;
    }
    const rid = str(stat['rid']) ?? '-';
    const codecId = str(stat['codecId']);
    layers.push({
      rid,
      width: num(stat['frameWidth']),
      height: num(stat['frameHeight']),
      fps: num(stat['framesPerSecond']),
      bitrateKbps: meter.kbps(
        `${track.sid ?? 'local'}:${str(stat['id']) ?? rid}`,
        num(stat['bytesSent']),
        num(stat['timestamp']),
      ),
      codec: codecId ? (codecs.get(codecId) ?? null) : null,
      encoder: str(stat['encoderImplementation']),
      limitation: str(stat['qualityLimitationReason']),
      active: typeof stat['active'] === 'boolean' ? stat['active'] : null,
    });
  }
  return layers.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
}

export async function readInbound(
  track: RemoteTrack,
  meter: BitrateMeter,
): Promise<InboundStats | null> {
  const report = await track.getRTCStatsReport();
  if (!report) {
    return null;
  }
  const { stats, codecs } = collect(report);
  const inbound = stats.find((stat) => stat['type'] === 'inbound-rtp');
  if (!inbound) {
    return null;
  }
  const codecId = str(inbound['codecId']);
  const jitter = num(inbound['jitter']);
  return {
    kind: inbound['kind'] === 'audio' ? 'audio' : 'video',
    width: num(inbound['frameWidth']),
    height: num(inbound['frameHeight']),
    fps: num(inbound['framesPerSecond']),
    bitrateKbps: meter.kbps(
      `${track.sid ?? 'remote'}:in`,
      num(inbound['bytesReceived']),
      num(inbound['timestamp']),
    ),
    codec: codecId ? (codecs.get(codecId) ?? null) : null,
    decoder: str(inbound['decoderImplementation']),
    framesDropped: num(inbound['framesDropped']),
    packetsLost: num(inbound['packetsLost']),
    jitterMs: jitter === null ? null : Math.round(jitter * 1000),
  };
}
