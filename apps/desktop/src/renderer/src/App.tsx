import { useEffect } from 'react';
import { AuthScreen } from './features/auth/AuthScreen';
import { MainLayout } from './features/layout/MainLayout';
import { Spinner } from './components/Icons';
import { useSession } from './stores/session';
import { VoiceProvider } from './voice/VoiceProvider';

function Screens() {
  const status = useSession((state) => state.status);

  if (status === 'booting') {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Spinner size={28} />
      </div>
    );
  }
  return status === 'authenticated' ? <MainLayout /> : <AuthScreen />;
}

export function App() {
  useEffect(() => {
    void useSession.getState().boot();
  }, []);

  return (
    <VoiceProvider>
      <Screens />
    </VoiceProvider>
  );
}
