import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH, type Channel } from '@livekit-app/shared';
import { errorMessage } from '../../lib/api';
import { sendMessage, useRealtime } from '../../lib/realtime';

const MAX_ROWS_HEIGHT_PX = 200;
const COUNTER_THRESHOLD = MESSAGE_MAX_LENGTH - 200;

export function Composer({ channel }: { channel: Channel }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const connected = useRealtime((state) => state.status === 'connected');

  const trimmed = text.trim();
  const tooLong = trimmed.length > MESSAGE_MAX_LENGTH;
  const canSend = trimmed.length > 0 && !tooLong && !sending && connected;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [channel.id]);

  const submit = async () => {
    if (!canSend) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendMessage({ channelId: channel.id, content: trimmed });
      setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      <div className="flex items-end gap-2 rounded-lg bg-zinc-700 px-3 py-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          maxLength={MESSAGE_MAX_LENGTH + 500}
          placeholder={connected ? `Conversar em #${channel.name}` : 'Aguardando conexão...'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-[200px] flex-1 resize-none bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-400"
        />
        {trimmed.length >= COUNTER_THRESHOLD && (
          <span className={`text-xs ${tooLong ? 'text-red-400' : 'text-zinc-400'}`}>
            {MESSAGE_MAX_LENGTH - trimmed.length}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">Enter envia · Shift+Enter quebra linha</p>
    </div>
  );
}
