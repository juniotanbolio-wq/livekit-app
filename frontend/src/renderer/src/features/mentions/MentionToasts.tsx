import { useEffect } from 'react';
import { BellIcon, XIcon } from '../../components/Icons';
import { useMentions, type ReceivedMention } from '../../stores/mentions';

const AUTO_DISMISS_MS = 20_000;

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function MentionToast({ mention }: { mention: ReceivedMention }) {
  const dismiss = useMentions((state) => state.dismiss);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(mention.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [mention.id, dismiss]);

  return (
    <div
      role="status"
      data-mention-toast={mention.fromUsername}
      className="pointer-events-auto flex w-80 items-start gap-3 rounded-lg border border-amber-500/40 bg-zinc-900 p-3 shadow-2xl"
    >
      <BellIcon size={20} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <b>{mention.fromUsername}</b> está chamando você
        </p>
        {mention.message && (
          <p className="mt-1 text-sm break-words text-zinc-300" data-mention-message>
            “{mention.message}”
          </p>
        )}
        <p className="mt-1 text-xs text-zinc-500">{formatTime(mention.sentAt)}</p>
      </div>
      <button
        type="button"
        title="Fechar"
        onClick={() => dismiss(mention.id)}
        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

// Aviso dentro do app para cada "chamar atenção" recebido (o toast do Windows sai pelo processo principal).
export function MentionToasts() {
  const received = useMentions((state) => state.received);
  if (received.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {received.map((mention) => (
        <MentionToast key={mention.id} mention={mention} />
      ))}
    </div>
  );
}
