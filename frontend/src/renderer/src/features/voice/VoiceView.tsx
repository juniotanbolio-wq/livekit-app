import type { Channel, PresenceParticipant } from '../../lib/api';
import { usePresence } from '../../stores/presence';
import { useVoice } from '../../stores/voice';
import { EyeIcon, LiveBadge, SpeakerIcon, Spinner, XIcon } from '../../components/Icons';
import { useWatch } from '../../stores/watch';
import { useLiveChannelIds } from '../stream/useLiveChannels';
import { VoiceControls } from './VoiceControls';
import { VoiceGrid } from './VoiceGrid';

// Referência fixa: um `[]` novo a cada leitura faria o Zustand achar que o estado mudou e renderizar em
// laço (erro React #185) enquanto o canal ainda não aparece na presença.
const NO_PARTICIPANTS: PresenceParticipant[] = [];

function VoiceError() {
  const error = useVoice((state) => state.error);
  const setError = useVoice((state) => state.setError);
  if (!error) {
    return null;
  }
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">
      <span className="flex-1" data-voice-error>
        {error}
      </span>
      <button
        type="button"
        title="Fechar"
        onClick={() => setError(null)}
        className="rounded p-0.5 hover:bg-red-500/20"
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}

function NotConnected({ channel }: { channel: Channel }) {
  const join = useVoice((state) => state.join);
  const inOtherVoice = useVoice(
    (state) =>
      state.connection !== 'idle' && state.channelId !== null && state.channelId !== channel.id,
  );
  const watch = useWatch((state) => state.watch);
  const participants = usePresence((state) => state.byChannel[channel.id] ?? NO_PARTICIPANTS);
  const live = useLiveChannelIds().has(channel.id);
  const sharers = participants.filter((participant) => participant.isScreenSharing);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <SpeakerIcon size={40} className="text-zinc-500" />
      <div>
        <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
          {channel.name}
          {live && <LiveBadge />}
        </h2>
        <p className="text-sm text-zinc-400">
          {participants.length === 0
            ? 'Ninguém neste canal ainda'
            : `${participants.map((participant) => participant.username).join(', ')} ${
                participants.length === 1 ? 'está' : 'estão'
              } aqui`}
        </p>
        {inOtherVoice && (
          <p className="mt-1 text-xs text-zinc-500">
            Você está na voz de outro canal. Assistir não tira você de lá.
          </p>
        )}
      </div>
      {/* Uma linha por transmissão ao vivo (presença do WebSocket). Assistir daqui abre o Modo Espectador:
          só a tela é assinada, nunca microfones ou câmeras do canal. */}
      {sharers.length > 0 && (
        <ul className="w-full max-w-sm space-y-2" data-live-list>
          {sharers.map((participant) => (
            <li
              key={participant.userId}
              className="flex items-center gap-3 rounded-md bg-zinc-900/60 px-3 py-2 text-left"
            >
              <LiveBadge />
              <span className="flex-1 truncate text-sm">Tela de {participant.username}</span>
              <button
                type="button"
                data-watch-identity={participant.userId}
                onClick={() => watch(channel.id, participant.userId)}
                className="flex items-center gap-2 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
              >
                <EyeIcon size={16} />
                Assistir
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => void join(channel.id)}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
      >
        Entrar na voz
      </button>
    </div>
  );
}

export function VoiceView({ channel }: { channel: Channel }) {
  const voiceChannelId = useVoice((state) => state.channelId);
  const connection = useVoice((state) => state.connection);
  const isThisChannel = voiceChannelId === channel.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-900/60 px-4 shadow-sm">
        <SpeakerIcon size={18} className="text-zinc-500" />
        <h1 className="font-semibold">{channel.name}</h1>
        {isThisChannel && connection === 'reconnecting' && (
          <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
            Reconectando...
          </span>
        )}
      </header>
      <VoiceError />
      {isThisChannel && connection === 'connecting' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-400">
          <Spinner size={20} /> Conectando ao canal...
        </div>
      )}
      {isThisChannel && (connection === 'connected' || connection === 'reconnecting') && (
        <>
          <VoiceGrid channelId={channel.id} />
          <VoiceControls />
        </>
      )}
      {(!isThisChannel || connection === 'idle') && <NotConnected channel={channel} />}
    </div>
  );
}
