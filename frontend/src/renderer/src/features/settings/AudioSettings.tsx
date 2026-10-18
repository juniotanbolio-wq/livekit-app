import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/api';
import {
  GATE_MAX_DB,
  GATE_MIN_DB,
  captureOptionsFor,
  currentAudioSettings,
  useAudioSettings,
  type SuppressionMode,
} from '../../stores/audio-settings';
import { useVoice } from '../../stores/voice';
import { VoiceProcessor } from '../../voice/audio-processing';

const MODES: { id: SuppressionMode; label: string; hint: string }[] = [
  {
    id: 'off',
    label: 'Desligada',
    hint: 'Sem supressão de ruído (microfone bom em ambiente silencioso).',
  },
  { id: 'standard', label: 'Padrão', hint: 'Supressão nativa do navegador. Leve.' },
  {
    id: 'advanced',
    label: 'Avançada (RNNoise)',
    hint: 'Rede neural local, remove teclado, ventilador e ruído de fundo. Usa um pouco mais de CPU.',
  },
];

// "Testar microfone": captura com as mesmas restrições e o mesmo processador da voz e toca de volta na saída
// escolhida, para a pessoa ouvir exatamente o que os outros vão ouvir. Independente da sala: funciona fora da
// voz e não interrompe o microfone publicado.
function useMicTest(active: boolean): { level: number | null; error: string | null } {
  const suppression = useAudioSettings((state) => state.suppression);
  const devices = useVoice((state) => state.devices);
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const processorRef = useRef<VoiceProcessor | null>(null);

  // A supressão nativa e o dispositivo são restrições da captura: mudar qualquer um reinicia o teste.
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    let raw: MediaStreamTrack | null = null;
    let timer: number | null = null;
    const audio = new Audio();
    const processor = new VoiceProcessor(currentAudioSettings());
    processorRef.current = processor;

    const start = async () => {
      const options = captureOptionsFor(currentAudioSettings(), devices.audioinput);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: options.echoCancellation,
          autoGainControl: options.autoGainControl,
          noiseSuppression: options.noiseSuppression,
          ...(devices.audioinput ? { deviceId: { exact: devices.audioinput } } : {}),
        },
      });
      raw = stream.getAudioTracks()[0] ?? null;
      if (cancelled || !raw) {
        return;
      }
      await processor.init({ track: raw });
      if (cancelled || !processor.processedTrack) {
        return;
      }
      audio.srcObject = new MediaStream([processor.processedTrack]);
      if (devices.audiooutput) {
        await audio.setSinkId(devices.audiooutput).catch(() => undefined);
      }
      await audio.play();
      setError(null);
      timer = window.setInterval(() => setLevel(processor.levelDb()), 100);
    };
    start().catch((err: unknown) => {
      if (!cancelled) {
        setError(`Não foi possível testar o microfone: ${errorMessage(err)}`);
      }
    });

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearInterval(timer);
      }
      audio.pause();
      audio.srcObject = null;
      processorRef.current = null;
      void processor.destroy();
      raw?.stop();
      setLevel(null);
    };
  }, [active, suppression, devices.audioinput, devices.audiooutput]);

  // Gate e limite mudam ao vivo, sem reabrir o microfone.
  useEffect(() => {
    return useAudioSettings.subscribe((next) => {
      void processorRef.current?.update({
        suppression: next.suppression,
        gateEnabled: next.gateEnabled,
        gateThresholdDb: next.gateThresholdDb,
      });
    });
  }, []);

  return { level, error };
}

function LevelMeter({ level, threshold }: { level: number | null; threshold: number | null }) {
  const toPercent = (db: number) =>
    Math.min(100, Math.max(0, ((db - GATE_MIN_DB) / (0 - GATE_MIN_DB)) * 100));
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded bg-zinc-700"
      data-mic-level={level ?? ''}
    >
      {level !== null && (
        <div
          className={`h-full ${threshold !== null && level < threshold ? 'bg-zinc-500' : 'bg-emerald-500'}`}
          style={{ width: `${toPercent(level)}%` }}
        />
      )}
      {threshold !== null && (
        <div
          className="absolute top-0 h-full w-0.5 bg-amber-400"
          style={{ left: `${toPercent(threshold)}%` }}
        />
      )}
    </div>
  );
}

// Aba "Áudio" das Configurações (features/settings/SettingsDialog.tsx).
export function AudioSettingsPanel() {
  const suppression = useAudioSettings((state) => state.suppression);
  const gateEnabled = useAudioSettings((state) => state.gateEnabled);
  const gateThresholdDb = useAudioSettings((state) => state.gateThresholdDb);
  const setSuppression = useAudioSettings((state) => state.setSuppression);
  const setGateEnabled = useAudioSettings((state) => state.setGateEnabled);
  const setGateThreshold = useAudioSettings((state) => state.setGateThreshold);
  const [testing, setTesting] = useState(false);
  const { level, error } = useMicTest(testing);

  return (
    <div className="space-y-4" data-audio-settings>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
          Supressão de ruído
        </legend>
        {MODES.map((mode) => (
          <label key={mode.id} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="suppression"
              value={mode.id}
              checked={suppression === mode.id}
              data-suppression={mode.id}
              onChange={() => setSuppression(mode.id)}
              className="mt-1 accent-indigo-500"
            />
            <span>
              {mode.label}
              <span className="block text-xs text-zinc-500">{mode.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={gateEnabled}
            data-gate-enabled
            onChange={(event) => setGateEnabled(event.target.checked)}
            className="h-4 w-4 accent-indigo-500"
          />
          Noise gate (corta o som abaixo do limite)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={GATE_MIN_DB}
            max={GATE_MAX_DB}
            step={1}
            value={gateThresholdDb}
            disabled={!gateEnabled}
            aria-label="Limite do noise gate"
            data-gate-threshold
            onChange={(event) => setGateThreshold(Number(event.target.value))}
            className="flex-1 accent-amber-400 disabled:opacity-40"
          />
          <span className="w-16 text-right text-xs text-zinc-300">{gateThresholdDb} dB</span>
        </div>
        <LevelMeter level={level} threshold={gateEnabled ? gateThresholdDb : null} />
        <p className="text-xs text-zinc-500">
          {testing
            ? 'Fale normalmente: a barra verde precisa passar da marca amarela. Abaixo dela o som é cortado.'
            : 'Use "Testar microfone" para ver o nível da sua voz e ajustar o limite.'}
        </p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          data-mic-test
          onClick={() => setTesting((current) => !current)}
          className={`rounded-md px-4 py-2 text-sm font-medium text-white ${
            testing ? 'bg-red-600 hover:bg-red-500' : 'bg-indigo-600 hover:bg-indigo-500'
          }`}
        >
          {testing ? 'Parar teste' : 'Testar microfone'}
        </button>
        <p className="text-xs text-zinc-500">
          Você ouve a própria voz já processada. Use fones de ouvido para não gerar eco.
          Cancelamento de eco e ganho automático ficam sempre ligados.
        </p>
        {error && (
          <div role="alert" className="rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
