import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Message } from '@livekit-app/shared';
import { emptyChannelChat, useChat } from '../../stores/chat';
import { useSession } from '../../stores/session';
import { Spinner } from '../../components/Icons';

const BOTTOM_THRESHOLD_PX = 80;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return isSameDay(date, new Date())
    ? `Hoje às ${timeFormat.format(date)}`
    : dateFormat.format(date);
}

function startsGroup(message: Message, previous: Message | undefined): boolean {
  if (!previous || previous.author.id !== message.author.id) {
    return true;
  }
  return Date.parse(message.createdAt) - Date.parse(previous.createdAt) > GROUP_WINDOW_MS;
}

function MessageItem({ message, grouped }: { message: Message; grouped: boolean }) {
  return (
    <li
      className={`group flex gap-3 px-4 hover:bg-zinc-900/30 ${grouped ? 'py-0.5' : 'mt-3 py-0.5'}`}
    >
      <div className="w-9 shrink-0">
        {!grouped && (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white uppercase">
            {message.author.username.slice(0, 1)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-zinc-100">{message.author.username}</span>
            <time className="text-xs text-zinc-500" dateTime={message.createdAt}>
              {formatTimestamp(message.createdAt)}
            </time>
          </div>
        )}
        <p className="text-sm break-words whitespace-pre-wrap text-zinc-200">{message.content}</p>
      </div>
    </li>
  );
}

export function MessageList({ channelId }: { channelId: string }) {
  const chat = useChat((state) => state.byChannel[channelId] ?? emptyChannelChat);
  const loadOlder = useChat((state) => state.loadOlder);
  const loadInitial = useChat((state) => state.loadInitial);
  const myId = useSession((state) => state.user?.id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);

  const first = chat.messages[0];
  const last = chat.messages.at(-1);

  const requestOlder = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !chat.loaded || !chat.hasMore || chat.loadingOlder) {
      return;
    }
    prependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    void loadOlder(channelId);
  }, [channelId, chat.hasMore, chat.loaded, chat.loadingOlder, loadOlder]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = topRef.current;
    if (!root || !target) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          requestOlder();
        }
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [requestOlder]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const firstChanged = first?.id !== firstIdRef.current;
    const lastChanged = last?.id !== lastIdRef.current;
    const wasEmpty = lastIdRef.current === undefined;
    firstIdRef.current = first?.id;
    lastIdRef.current = last?.id;

    const anchor = prependAnchorRef.current;
    if (firstChanged && anchor && !lastChanged) {
      element.scrollTop = element.scrollHeight - anchor.height + anchor.top;
      prependAnchorRef.current = null;
      return;
    }
    if (!lastChanged) {
      return;
    }
    if (wasEmpty || atBottomRef.current || last?.author.id === myId) {
      element.scrollTop = element.scrollHeight;
      atBottomRef.current = true;
    }
  }, [first?.id, last?.id, last?.author.id, myId]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    atBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX;
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div ref={topRef} className="h-px" />
      {chat.loaded && !chat.hasMore && (
        <div className="px-4 pt-6 pb-2 text-sm text-zinc-500">Este é o começo do canal.</div>
      )}
      {(chat.loadingOlder || chat.loadingInitial) && (
        <div className="flex justify-center py-3 text-zinc-400">
          <Spinner />
        </div>
      )}
      {chat.error && (
        <div className="mx-4 my-2 flex items-center gap-3 rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">
          <span className="flex-1">{chat.error}</span>
          <button
            type="button"
            onClick={() => void (chat.loaded ? requestOlder() : loadInitial(channelId))}
            className="rounded bg-red-500/20 px-2 py-0.5 hover:bg-red-500/30"
          >
            Tentar novamente
          </button>
        </div>
      )}
      <ol className="pb-4">
        {chat.messages.map((message, index) => (
          <MessageItem
            key={message.id}
            message={message}
            grouped={!startsGroup(message, chat.messages[index - 1])}
          />
        ))}
      </ol>
    </div>
  );
}
