import { useEffect, useRef, useState } from 'react';
import type { Channel } from '../../lib/api';
import { useVoice } from '../../stores/voice';
import { useWatch } from '../../stores/watch';
import {
  EyeOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LiveBadge,
  MaximizeIcon,
  PhoneIcon,
  SpeakerIcon,
  XIcon,
} from '../../components/Icons';
import { VoiceControls } from '../voice/VoiceControls';
import { StreamPlayer } from './StreamPlayer';

function HeaderButton({
  title,
  onClick,
  children,
  active,
}: {
  title: string;
  onClick(): void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-zinc-700 ${
        active ? 'text-emerald-400' : 'text-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}

export function StreamView({ channel }: { channel: Channel }) {
  const streams = useWatch((state) => state.streams);
  const selectedIdentity = useWatch((state) => state.selectedIdentity);
  const audioEnabled = useWatch((state) => state.audioEnabled);
  const volume = useWatch((state) => state.volume);
  const spectatorConnection = useWatch((state) => state.spectatorConnection);
  const error = useWatch((state) => state.error);
  const spectatorRoom = useWatch((state) => state.room);
  const stop = useWatch((state) => state.stop);
  const selectStream = useWatch((state) => state.selectStream);
  const setAudioEnabled = useWatch((state) => state.setAudioEnabled);
  const setVolume = useWatch((state) => state.setVolume);
  const setPlayerVisible = useWatch((state) => state.setPlayerVisible);
  const reconcile = useWatch((state) => state.reconcile);
  const voiceRoom = useVoice((state) => state.room);
  const joinVoice = useVoice((state) => state.join);
  const inVoiceHere = useVoice(
    (state) => state.channelId === channel.id && state.connection !== 'idle',
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setPlayerVisible(true);
    return () => setPlayerVisible(false);
  }, [setPlayerVisible]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const mode = inVoiceHere ? 'voice' : 'spectator';
  const room = mode === 'voice' ? voiceRoom : spectatorRoom;
  const selected = streams.find((stream) => stream.identity === selectedIdentity);

  const toggleFullscreen = () => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void element.requestFullscreen().catch(() => undefined);
    }
  };

  const placeholder =
    mode === 'spectator' && spectatorConnection === 'connecting'
      ? 'Conectando à transmissão...'
      : mode === 'spectator' && spectatorConnection === 'reconnecting'
        ? 'Reconectando à transmissão...'
        : 'Nenhuma transmissão ativa neste canal';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-900/60 px-4 shadow-sm">
        <SpeakerIcon size={18} className="text-zinc-500" />
        <h1 className="font-semibold">{channel.name}</h1>
        {streams.length > 0 && <LiveBadge />}
        <span className="text-xs text-zinc-500" data-watch-mode={mode}>
          {mode === 'voice' ? 'pela sua conexão de voz' : 'modo espectador'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {streams.length > 1 && (
            <select
              aria-label="Escolher transmissão"
              value={selectedIdentity ?? ''}
              onChange={(event) => selectStream(event.target.value)}
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none"
            >
              {streams.map((stream) => (
                <option key={stream.identity} value={stream.identity}>
                  Tela de {stream.name}
                </option>
              ))}
            </select>
          )}
          {mode === 'spectator' && selected?.hasAudio && (
            <>
              <HeaderButton
                title={
                  audioEnabled ? 'Desligar áudio da transmissão' : 'Ouvir áudio da transmissão'
                }
                active={audioEnabled}
                onClick={() => setAudioEnabled(!audioEnabled)}
              >
                {audioEnabled ? <HeadphonesIcon size={16} /> : <HeadphonesOffIcon size={16} />}
              </HeaderButton>
              {audioEnabled && (
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(volume * 100)}
                  aria-label="Volume da transmissão"
                  onChange={(event) => setVolume(Number(event.target.value) / 100)}
                  className="w-24 accent-emerald-500"
                />
              )}
            </>
          )}
          {mode === 'spectator' && (
            <HeaderButton
              title="Entrar na voz deste canal"
              onClick={() => void joinVoice(channel.id)}
            >
              <PhoneIcon size={16} />
              <span>Entrar na voz</span>
            </HeaderButton>
          )}
          <HeaderButton title="Tela cheia (Esc para sair)" onClick={toggleFullscreen}>
            <MaximizeIcon size={16} />
          </HeaderButton>
          <HeaderButton title="Parar de assistir" onClick={stop}>
            <EyeOffIcon size={16} />
            <span>Parar de assistir</span>
          </HeaderButton>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded bg-red-500/15 px-3 py-2 text-sm text-red-300">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => void reconcile()}
            className="rounded bg-red-500/20 px-2 py-0.5 hover:bg-red-500/30"
          >
            Tentar novamente
          </button>
          <button
            type="button"
            title="Parar"
            onClick={stop}
            className="rounded p-0.5 hover:bg-red-500/20"
          >
            <XIcon size={16} />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        onDoubleClick={toggleFullscreen}
        className={`relative min-h-0 flex-1 bg-black ${fullscreen ? '' : 'm-4 overflow-hidden rounded-lg'}`}
      >
        {room && <StreamPlayer room={room} identity={selectedIdentity} placeholder={placeholder} />}
        {selected && !fullscreen && (
          <div className="absolute bottom-3 left-3 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
            Tela de {selected.name}
          </div>
        )}
      </div>

      {mode === 'voice' && <VoiceControls />}
    </div>
  );
}
