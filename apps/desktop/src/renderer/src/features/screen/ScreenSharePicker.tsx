import { useEffect, useState } from 'react';
import type { ScreenSource, ScreenSourceKind } from '../../../../shared/desktop-api';
import { errorMessage } from '../../lib/api';
import {
  SCREEN_CODECS,
  SCREEN_QUALITIES,
  SCREEN_QUALITY_IDS,
  isScreenCodec,
  isScreenQualityId,
} from '../../lib/screen-presets';
import { useScreenShare } from '../../stores/screen-share';
import { RefreshIcon, Spinner, XIcon } from '../../components/Icons';

const TABS: { kind: ScreenSourceKind; label: string }[] = [
  { kind: 'screen', label: 'Telas' },
  { kind: 'window', label: 'Janelas' },
];

const loopbackSupported = window.desktop.platform === 'win32';

export function ScreenSharePicker() {
  const quality = useScreenShare((state) => state.quality);
  const codec = useScreenShare((state) => state.codec);
  const status = useScreenShare((state) => state.status);
  const shareError = useScreenShare((state) => state.error);
  const setQuality = useScreenShare((state) => state.setQuality);
  const setCodec = useScreenShare((state) => state.setCodec);
  const start = useScreenShare((state) => state.start);
  const closePicker = useScreenShare((state) => state.closePicker);

  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [tab, setTab] = useState<ScreenSourceKind>('screen');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeAudio, setIncludeAudio] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.desktop.listScreenSources().then(
      (list) => {
        if (cancelled) {
          return;
        }
        setListError(null);
        setSources(list);
        setSelectedId((current) =>
          current && list.some((source) => source.id === current)
            ? current
            : (list.find((source) => source.kind === 'screen')?.id ?? list[0]?.id ?? null),
        );
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) {
          return;
        }
        setListError(`Não foi possível listar telas e janelas: ${errorMessage(err)}`);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((key) => key + 1);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && status !== 'starting') {
        closePicker();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePicker, status]);

  const visible = sources.filter((source) => source.kind === tab);
  const starting = status === 'starting';

  const onShare = () => {
    if (selectedId) {
      void start(selectedId, includeAudio && loopbackSupported);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compartilhar tela"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => !starting && closePicker()}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col gap-4 rounded-lg bg-zinc-800 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Compartilhar tela</h2>
          <button
            type="button"
            title="Fechar"
            disabled={starting}
            onClick={closePicker}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {TABS.map((item) => (
            <button
              key={item.kind}
              type="button"
              onClick={() => setTab(item.kind)}
              className={`rounded px-3 py-1.5 text-sm ${
                tab === item.kind ? 'bg-zinc-600 text-white' : 'text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            title="Atualizar lista"
            onClick={refresh}
            className="ml-auto rounded p-1.5 text-zinc-300 hover:bg-zinc-700"
          >
            <RefreshIcon size={16} />
          </button>
        </div>

        <div className="min-h-48 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-zinc-400">
              <Spinner size={24} />
            </div>
          ) : listError ? (
            <div className="rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">{listError}</div>
          ) : visible.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-zinc-400">
              Nada para compartilhar nesta aba
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {visible.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  data-source-id={source.id}
                  onClick={() => setSelectedId(source.id)}
                  onDoubleClick={onShare}
                  className={`flex flex-col gap-2 rounded-lg p-2 text-left ring-2 ${
                    selectedId === source.id
                      ? 'bg-zinc-700 ring-indigo-500'
                      : 'bg-zinc-900/60 ring-transparent hover:bg-zinc-700/60'
                  }`}
                >
                  <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-black">
                    {source.thumbnail ? (
                      <img src={source.thumbnail} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-xs text-zinc-500">Sem prévia</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {source.appIcon && <img src={source.appIcon} alt="" className="h-4 w-4" />}
                    <span className="truncate text-xs text-zinc-200">{source.name}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold tracking-wide text-zinc-300 uppercase">
              Qualidade
            </span>
            <select
              value={quality}
              onChange={(event) => {
                if (isScreenQualityId(event.target.value)) {
                  setQuality(event.target.value);
                }
              }}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {SCREEN_QUALITY_IDS.map((id) => (
                <option key={id} value={id}>
                  {SCREEN_QUALITIES[id].label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold tracking-wide text-zinc-300 uppercase">
              Codec
            </span>
            <select
              value={codec}
              onChange={(event) => {
                if (isScreenCodec(event.target.value)) {
                  setCodec(event.target.value);
                }
              }}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {SCREEN_CODECS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rounded-md bg-zinc-900/60 p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={!loopbackSupported}
              onChange={(event) => setIncludeAudio(event.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            Incluir áudio do sistema
          </label>
          <p className={`mt-2 text-xs ${includeAudio ? 'text-amber-300' : 'text-zinc-500'}`}>
            {loopbackSupported
              ? 'Atenção: o áudio do sistema inclui tudo que toca no PC, inclusive as vozes do canal de voz. Quem estiver ouvindo vai escutar o próprio eco.'
              : 'A captura de áudio do sistema só está disponível no Windows.'}
          </p>
        </div>

        {shareError && (
          <div role="alert" className="rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">
            {shareError}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={starting}
            onClick={closePicker}
            className="rounded-md px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!selectedId || starting}
            onClick={onShare}
            className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            {starting && <Spinner />}
            Compartilhar
          </button>
        </div>
      </div>
    </div>
  );
}
