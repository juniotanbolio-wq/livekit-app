import { useEffect } from 'react';
import { PRESENCE_POLL_INTERVAL_MS } from '../../../../api/types';
import { selectChannel, useChannels } from '../../stores/channels';
import { usePresence } from '../../stores/presence';
import { VoiceView } from '../voice/VoiceView';
import { ScreenSharePicker } from '../screen/ScreenSharePicker';
import { StreamView } from '../stream/StreamView';
import { useScreenShare } from '../../stores/screen-share';
import { useWatch } from '../../stores/watch';
import { Sidebar } from './Sidebar';
import { Spinner } from '../../components/Icons';

function usePresencePolling() {
  useEffect(() => {
    const refresh = () => {
      void usePresence.getState().refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, PRESENCE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}

function CentralArea() {
  const channel = useChannels((state) => selectChannel(state, state.viewedChannelId));
  const loading = useChannels((state) => state.loading);
  const error = useChannels((state) => state.error);
  const load = useChannels((state) => state.load);
  const watchedChannelId = useWatch((state) => state.watchedChannelId);

  if (!channel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-400">
        {loading ? (
          <Spinner size={24} />
        ) : (
          <>
            <span>{error ?? 'Nenhum canal disponível'}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded bg-zinc-700 px-3 py-1.5 text-zinc-100 hover:bg-zinc-600"
            >
              Tentar novamente
            </button>
          </>
        )}
      </div>
    );
  }

  if (watchedChannelId === channel.id) {
    return <StreamView channel={channel} />;
  }
  return <VoiceView channel={channel} />;
}

export function MainLayout() {
  const hasChannels = useChannels((state) => state.channels.length > 0);
  const load = useChannels((state) => state.load);
  const pickerOpen = useScreenShare((state) => state.pickerOpen);

  usePresencePolling();

  useEffect(() => {
    if (!hasChannels) {
      void load();
    }
  }, [hasChannels, load]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-zinc-800">
        <CentralArea />
      </main>
      {pickerOpen && <ScreenSharePicker />}
    </div>
  );
}
