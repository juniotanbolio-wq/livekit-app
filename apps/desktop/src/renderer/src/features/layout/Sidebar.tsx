import { useIsMuted, useIsSpeaking, useParticipants } from '@livekit/components-react';
import { Track, type Participant } from 'livekit-client';
import type { Channel, PresenceParticipant } from '@livekit-app/shared';
import { useChannels } from '../../stores/channels';
import { usePresence } from '../../stores/presence';
import { useVoice } from '../../stores/voice';
import {
  EyeIcon,
  HashIcon,
  LiveBadge,
  MicOffIcon,
  MonitorIcon,
  SpeakerIcon,
} from '../../components/Icons';
import { useWatch } from '../../stores/watch';
import { useLiveChannelIds } from '../stream/useLiveChannels';
import { UserPanel } from './UserPanel';
import { VoiceStatus, WatchStatus } from './VoiceStatus';

function Avatar({ name, speaking }: { name: string; speaking: boolean }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white uppercase ring-2 transition-shadow ${
        speaking ? 'ring-emerald-400' : 'ring-transparent'
      }`}
    >
      {name.slice(0, 1)}
    </span>
  );
}

function LiveParticipantRow({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const name = participant.name || participant.identity;
  return (
    <li className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300">
      <Avatar name={name} speaking={speaking} />
      <span className={`truncate ${speaking ? 'text-white' : ''}`}>{name}</span>
      {participant.isScreenShareEnabled && <MonitorIcon size={14} className="text-zinc-400" />}
      {micMuted && <MicOffIcon size={14} className="ml-auto text-zinc-500" />}
    </li>
  );
}

function LiveParticipants() {
  const participants = useParticipants();
  return (
    <ul className="ml-6 space-y-0.5">
      {participants.map((participant) => (
        <LiveParticipantRow key={participant.identity} participant={participant} />
      ))}
    </ul>
  );
}

function PresenceParticipants({ participants }: { participants: PresenceParticipant[] }) {
  if (participants.length === 0) {
    return null;
  }
  return (
    <ul className="ml-6 space-y-0.5">
      {participants.map((participant) => (
        <li
          key={participant.userId}
          className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-400"
        >
          <Avatar name={participant.username} speaking={false} />
          <span className="truncate">{participant.username}</span>
          {participant.isScreenSharing && <MonitorIcon size={14} className="text-zinc-500" />}
        </li>
      ))}
    </ul>
  );
}

function ChannelButton({
  channel,
  active,
  live = false,
  watching = false,
  onClick,
}: {
  channel: Channel;
  active: boolean;
  live?: boolean;
  watching?: boolean;
  onClick(): void;
}) {
  const Icon = channel.type === 'text' ? HashIcon : SpeakerIcon;
  return (
    <button
      type="button"
      data-channel={channel.name}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
        active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
    >
      <Icon size={16} className="shrink-0 text-zinc-500" />
      <span className="truncate">{channel.name}</span>
      {watching && <EyeIcon size={14} className="shrink-0 text-sky-400" />}
      {live && <LiveBadge className="ml-auto shrink-0" />}
    </button>
  );
}

export function Sidebar() {
  const channels = useChannels((state) => state.channels);
  const viewedChannelId = useChannels((state) => state.viewedChannelId);
  const view = useChannels((state) => state.view);
  const presence = usePresence((state) => state.byChannel);
  const voiceChannelId = useVoice((state) => state.channelId);
  const voiceConnection = useVoice((state) => state.connection);
  const join = useVoice((state) => state.join);
  const watchedChannelId = useWatch((state) => state.watchedChannelId);
  const liveChannels = useLiveChannelIds();

  const textChannels = channels.filter((channel) => channel.type === 'text');
  const voiceChannels = channels.filter((channel) => channel.type === 'voice');

  const openVoice = (channelId: string) => {
    view(channelId);
    const inThisVoice = voiceChannelId === channelId && voiceConnection !== 'idle';
    if (inThisVoice || watchedChannelId === channelId) {
      return;
    }
    if (voiceConnection === 'idle' && !liveChannels.has(channelId)) {
      void join(channelId);
    }
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col bg-zinc-900">
      <header className="flex h-12 items-center border-b border-zinc-950/60 px-4 font-semibold shadow-sm">
        LiveKit App
      </header>
      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <section>
          <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Canais de texto
          </h2>
          {textChannels.map((channel) => (
            <ChannelButton
              key={channel.id}
              channel={channel}
              active={viewedChannelId === channel.id}
              onClick={() => view(channel.id)}
            />
          ))}
        </section>
        <section>
          <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Canais de voz
          </h2>
          <div className="space-y-0.5">
            {voiceChannels.map((channel) => {
              const isMine = voiceChannelId === channel.id && voiceConnection !== 'idle';
              return (
                <div key={channel.id}>
                  <ChannelButton
                    channel={channel}
                    active={viewedChannelId === channel.id}
                    live={liveChannels.has(channel.id)}
                    watching={watchedChannelId === channel.id}
                    onClick={() => openVoice(channel.id)}
                  />
                  {isMine && voiceConnection === 'connected' ? (
                    <LiveParticipants />
                  ) : (
                    <PresenceParticipants participants={presence[channel.id] ?? []} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </nav>
      <VoiceStatus />
      <WatchStatus />
      <UserPanel />
    </aside>
  );
}
