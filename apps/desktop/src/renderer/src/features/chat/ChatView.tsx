import { useEffect } from 'react';
import type { Channel } from '@livekit-app/shared';
import { useRealtime } from '../../lib/realtime';
import { useChat } from '../../stores/chat';
import { HashIcon } from '../../components/Icons';
import { Composer } from './Composer';
import { MessageList } from './MessageList';

const STATUS_LABEL = {
  connecting: 'Conectando...',
  reconnecting: 'Reconectando...',
  disconnected: 'Desconectado',
} as const;

export function ChatView({ channel }: { channel: Channel }) {
  const loadInitial = useChat((state) => state.loadInitial);
  const status = useRealtime((state) => state.status);

  useEffect(() => {
    void loadInitial(channel.id);
  }, [channel.id, loadInitial]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-900/60 px-4 shadow-sm">
        <HashIcon size={18} className="text-zinc-500" />
        <h1 className="font-semibold">{channel.name}</h1>
        {status !== 'connected' && (
          <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
            {STATUS_LABEL[status]}
          </span>
        )}
      </header>
      <MessageList channelId={channel.id} />
      <Composer channel={channel} />
    </div>
  );
}
