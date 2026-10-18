import type { ScreenCodec } from './screen-presets';

// Escolha automática do codec da tela: o primeiro, na ordem abaixo, que a máquina codifica por GPU. Ordem
// decidida na Fase Q: H.264 tem codificação e decodificação por hardware em praticamente qualquer PC e mantém o
// simulcast; AV1 por hardware só existe em GPUs recentes e, no Chromium 152 do Windows, só com features em teste
// que não ligamos por padrão (main/media-flags.ts). Sem nenhum por hardware, H.264 em software (OpenH264).
const HARDWARE_ORDER: ScreenCodec[] = ['h264', 'av1'];
const SOFTWARE_FALLBACK: ScreenCodec = 'h264';

export type CodecSource = 'medido' | 'previsto' | 'padrão';

export interface CodecDecision {
  codec: ScreenCodec;
  hardware: boolean;
  source: CodecSource;
}

// Perfil que o LiveKit negocia (Constrained Baseline) e o modo de camadas que publicamos para cada codec: a
// pergunta ao Chromium precisa ser exatamente a configuração que vai ser usada, senão a resposta não vale.
const PROBES: Record<ScreenCodec, { contentType: string; scalabilityMode: string }> = {
  h264: {
    contentType:
      'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    scalabilityMode: 'L1T1',
  },
  vp8: { contentType: 'video/VP8', scalabilityMode: 'L1T1' },
  vp9: { contentType: 'video/VP9', scalabilityMode: 'L1T3' },
  av1: { contentType: 'video/AV1', scalabilityMode: 'L1T3' },
};

// O que as estatísticas mostraram de fato numa transmissão desta máquina. Vale mais que a previsão: o Chromium
// pode anunciar a GPU e cair para software ao iniciar o codificador (driver, sessões esgotadas).
interface MeasuredResult {
  hardware: boolean;
  encoder: string;
  at: string;
}

interface MeasuredStore {
  // Versão do Chromium + GPU ativa: trocar qualquer um dos dois invalida as medições.
  machine: string;
  results: Partial<Record<ScreenCodec, MeasuredResult>>;
}

const MEASURED_KEY = 'screen.encoderResults';

function chromiumVersion(): string {
  return /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'desconhecido';
}

let machineKey: Promise<string> | null = null;

function currentMachine(): Promise<string> {
  if (!machineKey) {
    machineKey = window.desktop
      .getDiagnostics()
      .then((info) => {
        const gpu = info.gpus.find((item) => item.active) ?? info.gpus[0];
        const gpuId = gpu ? `${gpu.vendorId.toString(16)}:${gpu.deviceId.toString(16)}` : 'sem-gpu';
        return `${chromiumVersion()}|${gpuId}|${gpu?.driverVersion ?? '-'}`;
      })
      .catch(() => `${chromiumVersion()}|sem-gpu`);
  }
  return machineKey;
}

function loadMeasured(machine: string): MeasuredStore {
  try {
    const raw = localStorage.getItem(MEASURED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MeasuredStore;
      if (parsed && parsed.machine === machine && typeof parsed.results === 'object') {
        return parsed;
      }
    }
  } catch {
    // Valor corrompido: começa do zero.
  }
  return { machine, results: {} };
}

export async function recordEncoderResult(
  codec: ScreenCodec,
  hardware: boolean,
  encoder: string,
): Promise<void> {
  const machine = await currentMachine();
  const store = loadMeasured(machine);
  const previous = store.results[codec];
  if (previous && previous.hardware === hardware && previous.encoder === encoder) {
    return;
  }
  store.results[codec] = { hardware, encoder, at: new Date().toISOString() };
  try {
    localStorage.setItem(MEASURED_KEY, JSON.stringify(store));
  } catch {
    return;
  }
}

async function predictHardware(codec: ScreenCodec): Promise<boolean | null> {
  const probe = PROBES[codec];
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: probe.contentType,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 60,
        scalabilityMode: probe.scalabilityMode,
      },
    });
    return info.supported ? info.powerEfficient : false;
  } catch {
    return null;
  }
}

// Resultado medido primeiro; sem medição, a previsão do Chromium (MediaCapabilities, que consulta a mesma fábrica
// de codificadores do WebRTC). Um codec que já saiu em software nesta máquina não é escolhido de novo.
export async function resolveAutoCodec(): Promise<CodecDecision> {
  const store = loadMeasured(await currentMachine());
  for (const codec of HARDWARE_ORDER) {
    const measured = store.results[codec];
    if (measured) {
      if (measured.hardware) {
        return { codec, hardware: true, source: 'medido' };
      }
      continue;
    }
    if (await predictHardware(codec)) {
      return { codec, hardware: true, source: 'previsto' };
    }
  }
  return { codec: SOFTWARE_FALLBACK, hardware: false, source: 'padrão' };
}

const CODEC_NAMES: Record<ScreenCodec, string> = {
  h264: 'H.264',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
};

export function describeDecision(decision: CodecDecision): string {
  const kind = decision.hardware ? 'por hardware' : 'em software';
  const origin =
    decision.source === 'medido'
      ? 'medido nesta máquina'
      : decision.source === 'previsto'
        ? 'previsto pelo Chromium'
        : 'nenhum codec por hardware disponível';
  return `${CODEC_NAMES[decision.codec]} ${kind} (${origin})`;
}

export function codecName(codec: ScreenCodec): string {
  return CODEC_NAMES[codec];
}
