import { useChannels } from '../../stores/channels';
import { useScreenShare } from '../../stores/screen-share';
import { useVoice } from '../../stores/voice';
import { useWatch } from '../../stores/watch';
import { EyeIcon, EyeOffIcon, LiveBadge, PhoneOffIcon } from '../../components/Icons';

const LABELS = {
  connecting: 'Conectando...',
  connected: 'Voz conectada',
  reconnecting: 'Reconectando...',
} as const;

const WATCH_LABELS = {
  idle: 'Assistindo',
  connecting: 'Conectando à transmissão...',
  connected: 'Assistindo',
  reconnecting: 'Reconectando à transmissão...',
} as const;

export function VoiceStatus() {
  const channelId = useVoice((state) => state.channelId);
  const connection = useVoice((state) => state.connection);
  const leave = useVoice((state) => state.leave);
  const sharing = useScreenShare((state) => state.status === 'live');
  const sharingAudio = useScreenShare((state) => state.hasAudio);
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
        {sharing && (
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-300">
            <LiveBadge />
            Transmitindo sua tela{sharingAudio ? ' com áudio' : ''}
          </span>
        )}
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

export function WatchStatus() {
  const watchedChannelId = useWatch((state) => state.watchedChannelId);
  const spectatorConnection = useWatch((state) => state.spectatorConnection);
  const streams = useWatch((state) => state.streams);
  const selectedIdentity = useWatch((state) => state.selectedIdentity);
  const stop = useWatch((state) => state.stop);
  const channels = useChannels((state) => state.channels);
  const view = useChannels((state) => state.view);
  const viaVoice = useVoice(
    (state) => state.channelId === watchedChannelId && state.connection !== 'idle',
  );

  if (!watchedChannelId) {
    return null;
  }
  const channel = channels.find((item) => item.id === watchedChannelId);
  const stream = streams.find((item) => item.identity === selectedIdentity);
  const label = viaVoice ? 'Assistindo' : WATCH_LABELS[spectatorConnection];

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <button
        type="button"
        title="Voltar para a transmissão"
        onClick={() => view(watchedChannelId)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <EyeIcon size={16} className="shrink-0 text-sky-400" />
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-sky-400">{label}</span>
          <span className="block truncate text-xs text-zinc-400">
            {channel?.name ?? ''}
            {stream ? ` · ${stream.name}` : ''}
          </span>
        </span>
      </button>
      <button
        type="button"
        title="Parar de assistir"
        onClick={stop}
        className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-red-400"
      >
        <EyeOffIcon size={18} />
      </button>
    </div>
  );
}
