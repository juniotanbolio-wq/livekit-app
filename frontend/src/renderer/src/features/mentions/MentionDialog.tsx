import { useEffect, useState, type FormEvent } from 'react';
import { MENTION_MESSAGE_MAX_LENGTH } from '../../../../generated/contract';
import { BellIcon, Spinner, XIcon } from '../../components/Icons';
import { MentionError } from '../../lib/realtime';
import { useRealtime } from '../../stores/realtime';

export interface MentionTarget {
  userId: string;
  username: string;
}

type Status = 'idle' | 'sending' | 'sent' | 'error';

const CLOSE_AFTER_SENT_MS = 1500;

// O servidor conta runas (pontos de código), não unidades UTF-16: um emoji vale 1, não 2.
function countChars(text: string): number {
  return [...text].length;
}

function describeError(err: unknown, username: string): string {
  if (!(err instanceof MentionError)) {
    return 'Não foi possível chamar atenção agora. Tente de novo.';
  }
  switch (err.code) {
    case 'recipient_offline':
      return `${username} está offline (sem o app aberto) e não pode ser chamado agora.`;
    case 'rate_limited_sender':
    case 'rate_limited_recipient':
      // A mensagem do servidor já diz em quantos segundos tentar de novo.
      return `Limite atingido. ${err.message}.`;
    case 'unknown_user':
      return 'Esse usuário não existe mais.';
    case 'self_mention':
      return 'Você não pode chamar a si mesmo.';
    default:
      return err.message;
  }
}

export function MentionDialog({ target, onClose }: { target: MentionTarget; onClose(): void }) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const sendMention = useRealtime((state) => state.sendMention);
  const connected = useRealtime((state) => state.status === 'connected');
  const length = countChars(message.trim());
  const tooLong = length > MENTION_MESSAGE_MAX_LENGTH;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (status !== 'sent') {
      return;
    }
    const timer = window.setTimeout(onClose, CLOSE_AFTER_SENT_MS);
    return () => window.clearTimeout(timer);
  }, [status, onClose]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (tooLong || status === 'sending') {
      return;
    }
    setStatus('sending');
    setError(null);
    try {
      await sendMention(target.userId, message.trim() || null);
      setStatus('sent');
    } catch (err) {
      setError(describeError(err, target.username));
      setStatus('error');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Chamar atenção de ${target.username}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        noValidate
        data-mention-dialog={target.username}
        data-mention-status={status}
        className="w-full max-w-sm space-y-4 rounded-lg bg-zinc-800 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <BellIcon size={18} className="text-amber-400" />
            Chamar atenção de {target.username}
          </h2>
          <button
            type="button"
            title="Fechar"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          >
            <XIcon size={18} />
          </button>
        </div>
        <label className="block" htmlFor="mentionMessage">
          <span className="mb-1 flex justify-between text-xs font-semibold tracking-wide text-zinc-300 uppercase">
            Mensagem (opcional)
            <span className={tooLong ? 'text-red-400' : 'text-zinc-500'}>
              {length}/{MENTION_MESSAGE_MAX_LENGTH}
            </span>
          </span>
          <input
            id="mentionMessage"
            type="text"
            value={message}
            autoFocus
            autoComplete="off"
            placeholder="Ex.: entra na voz 1!"
            onChange={(event) => {
              setMessage(event.target.value);
              if (status === 'error') {
                setStatus('idle');
                setError(null);
              }
            }}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </label>
        {error && (
          <div
            role="alert"
            data-mention-error
            className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-300"
          >
            {error}
          </div>
        )}
        {status === 'sent' && (
          <div
            data-mention-sent
            className="rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300"
          >
            Atenção enviada para {target.username}.
          </div>
        )}
        {!connected && status !== 'sent' && (
          <p className="text-xs text-amber-300">Sem conexão com o servidor no momento.</p>
        )}
        <button
          type="submit"
          disabled={tooLong || status === 'sending' || status === 'sent'}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-60"
        >
          {status === 'sending' && <Spinner />}
          Chamar atenção
        </button>
      </form>
    </div>
  );
}
