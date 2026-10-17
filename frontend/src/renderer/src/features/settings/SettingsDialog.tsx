import { useEffect, useState } from 'react';
import { XIcon } from '../../components/Icons';
import { useSession } from '../../stores/session';
import { ServerAddressForm } from '../server/ServerAddressForm';
import { DeviceSettingsPanel } from '../voice/DeviceSettings';

type Tab = 'devices' | 'server';

const TABS: { id: Tab; label: string }[] = [
  { id: 'devices', label: 'Dispositivos' },
  { id: 'server', label: 'Servidor' },
];

function ServerPanel() {
  const serverUrl = useSession((state) => state.serverUrl);
  const liveKitUrl = useSession((state) => state.liveKitUrl);

  return (
    <div className="space-y-4">
      <dl className="space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-zinc-400">Servidor:</dt>
          <dd className="truncate" data-current-server>
            {serverUrl ?? '-'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-zinc-400">Mídia (LiveKit):</dt>
          <dd className="truncate">{liveKitUrl ?? '-'}</dd>
        </div>
      </dl>
      <ServerAddressForm initialValue={serverUrl ?? ''} submitLabel="Salvar e reconectar" />
      <p className="text-xs text-zinc-500">
        Trocar de servidor encerra a sessão e sai da voz. Salvar o mesmo endereço só revalida o
        servidor (útil se o endereço de mídia dele mudou).
      </p>
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<Tab>('devices');

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
      aria-label="Configurações"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg bg-zinc-800 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Configurações</h2>
          <button
            type="button"
            title="Fechar"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div role="tablist" className="flex gap-1 border-b border-zinc-700">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              data-settings-tab={item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                tab === item.id
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'devices' ? <DeviceSettingsPanel /> : <ServerPanel />}
      </div>
    </div>
  );
}
