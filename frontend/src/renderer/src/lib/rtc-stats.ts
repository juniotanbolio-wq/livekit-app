import type { LocalTrack, RemoteTrack } from 'livekit-client';

// Leitura das estatísticas WebRTC (RTCStatsReport) para o painel de depuração e para a escolha automática de
// codec. Os nomes dos campos são os da especificação webrtc-stats; o Chromium preenche quase todos. Tudo é
// opcional: um campo ausente vira null em vez de quebrar o painel.

export interface OutboundVideoLayer {
  // rid da camada do simulcast (f = cheia, h = metade, q = um quarto); "-" quando não há simulcast (SVC).
  rid: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  // Nome do codificador (ex.: "SimulcastEncoderAdapter (OpenH264, OpenH264)" = software;
  // "MediaFoundationVideoEncodeAccelerator"/"D3D12VideoEncodeAccelerator" = GPU).
  encoder: string | null;
  // true = codificação por hardware. Só é exposto para páginas com captura ativa (é o nosso caso).
  powerEfficient: boolean | null;
  // "cpu" ou "bandwidth" quando o emissor está reduzindo a qualidade; "none" quando não.
  limitation: string | null;
  // false = camada pausada pelo dynacast (ninguém assistindo essa camada).
  active: boolean | null;
  // Tempo médio de codificação por quadro no último intervalo: a 60 fps o orçamento é 16,7 ms.
  msPerFrame: number | null;
  scalabilityMode: string | null;
}

export interface OutboundVideo {
  layers: OutboundVideoLayer[];
  // fps que a captura de fato entrega (media-source), e não o pedido no getDisplayMedia.
  sourceFps: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  totalKbps: number | null;
  // Estimativa de banda de subida do WebRTC (TWCC); se ficar abaixo do total pedido, camadas caem.
  availableOutgoingKbps: number | null;
  rttMs: number | null;
  degradationPreference: string | null;
}

export interface OutboundAudio {
  bitrateKbps: number | null;
  // Codec da estatística outbound-rtp. Com RED ativo o Chromium ainda informa audio/opus aqui (o RED é um
  // envelope do Opus): para saber se há redundância, use redActive.
  codec: string | null;
  // RED em uso: o WebRTC envia com o primeiro codec negociado, e só aplica RED se ele vier antes do Opus.
  redActive: boolean;
  maxBitrateKbps: number | null;
  packetsSent: number | null;
  // Codecs negociados no sender, na ordem de preferência: o WebRTC envia com o primeiro (RED só vale se vier
  // antes do Opus).
  negotiated: string[];
}

export interface InboundStats {
  kind: 'audio' | 'video';
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  decoder: string | null;
  powerEfficientDecoder: boolean | null;
  framesDropped: number | null;
  freezeCount: number | null;
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

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// Os contadores do WebRTC são acumulados desde o início; taxas (bitrate, ms por quadro) saem da diferença entre
// duas leituras. A chave identifica a série (trilha + id da estatística) para não misturar camadas.
export class StatsMeter {
  private readonly previous = new Map<string, { value: number; base: number }>();

  private delta(key: string, value: number | null, base: number | null): [number, number] | null {
    if (value === null || base === null) {
      return null;
    }
    const last = this.previous.get(key);
    this.previous.set(key, { value, base });
    // Contador que voltou (trilha republicada) ou base parada: sem taxa até a próxima leitura.
    if (!last || base <= last.base || value < last.value) {
      return null;
    }
    return [value - last.value, base - last.base];
  }

  kbps(key: string, bytes: number | null, timestampMs: number | null): number | null {
    const diff = this.delta(`${key}:bytes`, bytes, timestampMs);
    return diff ? Math.round((diff[0] * 8) / diff[1]) : null;
  }

  // totalEncodeTime (segundos) dividido pelos quadros codificados no mesmo intervalo, em ms.
  msPerFrame(key: string, totalSeconds: number | null, frames: number | null): number | null {
    const diff = this.delta(`${key}:encode`, totalSeconds, frames);
    return diff ? Math.round(((diff[0] * 1000) / diff[1]) * 10) / 10 : null;
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

// Par de candidatos ICE em uso: é dele que saem a estimativa de banda e o RTT.
function selectedPair(stats: StatRecord[]): StatRecord | null {
  const transport = stats.find((stat) => stat['type'] === 'transport');
  const pairId = transport ? str(transport['selectedCandidatePairId']) : null;
  if (pairId) {
    const pair = stats.find((stat) => stat['id'] === pairId);
    if (pair) {
      return pair;
    }
  }
  return (
    stats.find(
      (stat) =>
        stat['type'] === 'candidate-pair' &&
        stat['nominated'] === true &&
        stat['state'] === 'succeeded',
    ) ?? null
  );
}

function senderParameters(track: LocalTrack): RTCRtpSendParameters | null {
  try {
    return track.sender?.getParameters() ?? null;
  } catch {
    return null;
  }
}

export async function readOutboundVideo(
  track: LocalTrack,
  meter: StatsMeter,
): Promise<OutboundVideo | null> {
  const report = await track.getRTCStatsReport();
  if (!report) {
    return null;
  }
  const { stats, codecs } = collect(report);
  const prefix = track.sid ?? 'local';
  const layers: OutboundVideoLayer[] = [];
  for (const stat of stats) {
    if (stat['type'] !== 'outbound-rtp' || stat['kind'] !== 'video') {
      continue;
    }
    const rid = str(stat['rid']) ?? '-';
    const codecId = str(stat['codecId']);
    const key = `${prefix}:${str(stat['id']) ?? rid}`;
    layers.push({
      rid,
      width: num(stat['frameWidth']),
      height: num(stat['frameHeight']),
      fps: num(stat['framesPerSecond']),
      bitrateKbps: meter.kbps(key, num(stat['bytesSent']), num(stat['timestamp'])),
      codec: codecId ? (codecs.get(codecId) ?? null) : null,
      encoder: str(stat['encoderImplementation']),
      powerEfficient: bool(stat['powerEfficientEncoder']),
      limitation: str(stat['qualityLimitationReason']),
      active: bool(stat['active']),
      msPerFrame: meter.msPerFrame(key, num(stat['totalEncodeTime']), num(stat['framesEncoded'])),
      scalabilityMode: str(stat['scalabilityMode']),
    });
  }
  layers.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

  const source = stats.find((stat) => stat['type'] === 'media-source' && stat['kind'] === 'video');
  const pair = selectedPair(stats);
  const outgoing = pair ? num(pair['availableOutgoingBitrate']) : null;
  const rtt = pair ? num(pair['currentRoundTripTime']) : null;
  const rates = layers.map((layer) => layer.bitrateKbps).filter((value) => value !== null);
  const parameters = senderParameters(track);
  return {
    layers,
    sourceFps: source ? num(source['framesPerSecond']) : null,
    sourceWidth: source ? num(source['width']) : null,
    sourceHeight: source ? num(source['height']) : null,
    totalKbps: rates.length > 0 ? rates.reduce((sum, value) => sum + value, 0) : null,
    availableOutgoingKbps: outgoing === null ? null : Math.round(outgoing / 1000),
    rttMs: rtt === null ? null : Math.round(rtt * 1000),
    degradationPreference:
      (parameters as (RTCRtpSendParameters & { degradationPreference?: string }) | null)
        ?.degradationPreference ?? null,
  };
}

export async function readOutboundAudio(
  track: LocalTrack,
  meter: StatsMeter,
): Promise<OutboundAudio | null> {
  const report = await track.getRTCStatsReport();
  if (!report) {
    return null;
  }
  const { stats, codecs } = collect(report);
  const outbound = stats.find(
    (stat) => stat['type'] === 'outbound-rtp' && stat['kind'] === 'audio',
  );
  if (!outbound) {
    return null;
  }
  const codecId = str(outbound['codecId']);
  const parameters = senderParameters(track);
  const maxBitrate = parameters?.encodings[0]?.maxBitrate;
  const negotiated = (parameters?.codecs ?? []).map((codec) => codec.mimeType);
  return {
    negotiated,
    redActive: negotiated[0]?.toLowerCase() === 'audio/red',
    bitrateKbps: meter.kbps(
      `${track.sid ?? 'local'}:audio`,
      num(outbound['bytesSent']),
      num(outbound['timestamp']),
    ),
    codec: codecId ? (codecs.get(codecId) ?? null) : null,
    maxBitrateKbps: typeof maxBitrate === 'number' ? Math.round(maxBitrate / 1000) : null,
    packetsSent: num(outbound['packetsSent']),
  };
}

export async function readInbound(
  track: RemoteTrack,
  meter: StatsMeter,
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
    // O Chromium só expõe o decodificador para páginas com captura ativa; no espectador costuma vir vazio.
    decoder: str(inbound['decoderImplementation']),
    powerEfficientDecoder: bool(inbound['powerEfficientDecoder']),
    framesDropped: num(inbound['framesDropped']),
    freezeCount: num(inbound['freezeCount']),
    packetsLost: num(inbound['packetsLost']),
    jitterMs: jitter === null ? null : Math.round(jitter * 1000),
  };
}
