import { create } from 'zustand';
import type { AudioCaptureOptions, TrackPublishOptions } from 'livekit-client';

// Processamento da voz (Fase Q). Eco e ganho automático do navegador ficam sempre ligados; a supressão de
// ruído tem três modos:
// - off: nenhuma supressão (microfone de estúdio, ambiente silencioso).
// - standard: a supressão nativa do WebRTC (barata, já vem no Chromium).
// - advanced: RNNoise (rede neural pequena, roda local na CPU, voice/audio-processing.ts) no lugar da nativa.
//   A nativa é desligada para o RNNoise receber o sinal cru: as duas em série deformam a voz.
// O noise gate é independente: corta tudo abaixo do limite (teclado, ventilador) e, com o DTX do Opus, o
// microfone fechado quase não gasta banda.
export type SuppressionMode = 'off' | 'standard' | 'advanced';

export interface AudioSettings {
  suppression: SuppressionMode;
  gateEnabled: boolean;
  // Em dBFS (0 = volume máximo digital). Voz normal num headset fica entre -35 e -15.
  gateThresholdDb: number;
}

export const GATE_MIN_DB = -80;
export const GATE_MAX_DB = -10;

const DEFAULTS: AudioSettings = {
  suppression: 'standard',
  gateEnabled: false,
  gateThresholdDb: -50,
};
const STORAGE_KEY = 'voice.audio';

// Opus da voz: 64 kbps mono (o padrão do livekit-client é 48 kbps) é voz "cheia" sem custo relevante de banda;
// RED manda o pacote anterior junto com o atual (recupera perdas isoladas sem esperar retransmissão); DTX
// para de enviar durante o silêncio, o que com o gate fechado zera praticamente o tráfego.
export const VOICE_PUBLISH_OPTIONS: TrackPublishOptions = {
  audioPreset: { maxBitrate: 64_000 },
  dtx: true,
  red: true,
  forceStereo: false,
};

function isMode(value: unknown): value is SuppressionMode {
  return value === 'off' || value === 'standard' || value === 'advanced';
}

function clampGate(value: number): number {
  return Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, Math.round(value)));
}

function load(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULTS;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      suppression: isMode(parsed['suppression']) ? parsed['suppression'] : DEFAULTS.suppression,
      gateEnabled:
        typeof parsed['gateEnabled'] === 'boolean' ? parsed['gateEnabled'] : DEFAULTS.gateEnabled,
      gateThresholdDb:
        typeof parsed['gateThresholdDb'] === 'number' && Number.isFinite(parsed['gateThresholdDb'])
          ? clampGate(parsed['gateThresholdDb'])
          : DEFAULTS.gateThresholdDb,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(settings: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return;
  }
}

// Restrições do getUserMedia para o modo escolhido. voiceIsolation é a supressão "de sistema" (onde o SO
// oferece); segue a nativa.
export function captureOptionsFor(
  settings: AudioSettings,
  deviceId: string | undefined,
): AudioCaptureOptions {
  const native = settings.suppression === 'standard';
  return {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: native,
    voiceIsolation: native,
    ...(deviceId ? { deviceId } : {}),
  };
}

export function needsProcessor(settings: AudioSettings): boolean {
  return settings.suppression === 'advanced' || settings.gateEnabled;
}

interface AudioSettingsState extends AudioSettings {
  setSuppression(mode: SuppressionMode): void;
  setGateEnabled(enabled: boolean): void;
  setGateThreshold(db: number): void;
}

export const useAudioSettings = create<AudioSettingsState>()((set, get) => {
  const update = (patch: Partial<AudioSettings>) => {
    const { suppression, gateEnabled, gateThresholdDb } = { ...get(), ...patch };
    set(patch);
    save({ suppression, gateEnabled, gateThresholdDb });
  };
  return {
    ...load(),
    setSuppression(mode) {
      update({ suppression: mode });
    },
    setGateEnabled(enabled) {
      update({ gateEnabled: enabled });
    },
    setGateThreshold(db) {
      update({ gateThresholdDb: clampGate(db) });
    },
  };
});

export function currentAudioSettings(): AudioSettings {
  const { suppression, gateEnabled, gateThresholdDb } = useAudioSettings.getState();
  return { suppression, gateEnabled, gateThresholdDb };
}
