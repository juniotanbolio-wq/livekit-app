import { useEffect, useState } from 'react';
import { Room } from 'livekit-client';
import { errorMessage } from '../../lib/api';
import { useVoice, type DeviceKind } from '../../stores/voice';
import { XIcon } from '../../components/Icons';

const KINDS: { kind: DeviceKind; label: string }[] = [
  { kind: 'audioinput', label: 'Microfone' },
  { kind: 'audiooutput', label: 'Saída de áudio' },
  { kind: 'videoinput', label: 'Câmera' },
];

type DeviceLists = Record<DeviceKind, MediaDeviceInfo[]>;

const EMPTY_LISTS: DeviceLists = { audioinput: [], audiooutput: [], videoinput: [] };

function useDeviceLists(): { lists: DeviceLists; error: string | null } {
  const [lists, setLists] = useState<DeviceLists>(EMPTY_LISTS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const kinds: DeviceKind[] = ['audioinput', 'audiooutput', 'videoinput'];
      const results = await Promise.allSettled(
        kinds.map((kind) => Room.getLocalDevices(kind, kind !== 'audiooutput')),
      );
      if (cancelled) {
        return;
      }
      const next: DeviceLists = { ...EMPTY_LISTS };
      const failures: string[] = [];
      results.forEach((result, index) => {
        const kind = kinds[index];
        if (!kind) {
          return;
        }
        if (result.status === 'fulfilled') {
          next[kind] = result.value;
        } else {
          failures.push(
            `${KINDS.find((item) => item.kind === kind)?.label}: ${errorMessage(result.reason)}`,
          );
        }
      });
      setLists(next);
      setError(failures.length > 0 ? `Não foi possível listar: ${failures.join('; ')}` : null);
    };
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, []);

  return { lists, error };
}

export function DeviceSettings({ onClose }: { onClose(): void }) {
  const { lists, error } = useDeviceLists();
  const devices = useVoice((state) => state.devices);
  const setDevice = useVoice((state) => state.setDevice);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Dispositivos"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg bg-zinc-800 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Dispositivos</h2>
          <button
            type="button"
            title="Fechar"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          >
            <XIcon size={18} />
          </button>
        </div>
        {error && (
          <div className="rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>
        )}
        {KINDS.map(({ kind, label }) => {
          const options = lists[kind];
          const selected = devices[kind] ?? options[0]?.deviceId ?? '';
          return (
            <label key={kind} className="block">
              <span className="mb-1 block text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                {label}
              </span>
              <select
                value={selected}
                disabled={options.length === 0}
                onChange={(event) => void setDevice(kind, event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
              >
                {options.length === 0 && <option value="">Nenhum dispositivo encontrado</option>}
                {options.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `${label} ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        <p className="text-xs text-zinc-500">
          A escolha é salva neste computador e aplicada na hora se você estiver em um canal de voz.
        </p>
      </div>
    </div>
  );
}
