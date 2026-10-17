import { useChannels } from '../../stores/channels';
import { useVoice } from '../../stores/voice';
import { PhoneOffIcon } from '../../components/Icons';

const LABELS = {
  connecting: 'Conectando...',
  connected: 'Voz conectada',
  reconnecting: 'Reconectando...',
} as const;

export function VoiceStatus() {
  const channelId = useVoice((state) => state.channelId);
  const connection = useVoice((state) => state.connection);
  const leave = useVoice((state) => state.leave);
  const channels = useChannels((state) => state.channels);
  const view = useChannels((state) => state.view);

  if (!channelId || connection === 'idle') {
    return null;
  }
  const channel = channels.find((item) => item.id === channelId);

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <button type="button" onClick={() => view(channelId)} className="min-w-0 flex-1 text-left">
        <span
          className={`block text-xs font-semibold ${
            connection === 'connected' ? 'text-emerald-400' : 'text-amber-400'
          }`}
        >
          {LABELS[connection]}
        </span>
        <span className="block truncate text-xs text-zinc-400">{channel?.name ?? ''}</span>
      </button>
      <button
        type="button"
        title="Sair do canal de voz"
        onClick={() => void leave()}
        className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-red-400"
      >
        <PhoneOffIcon size={18} />
      </button>
    </div>
  );
}
