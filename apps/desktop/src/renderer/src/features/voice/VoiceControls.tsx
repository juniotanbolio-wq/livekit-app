import type { ReactNode } from 'react';
import { useVoice } from '../../stores/voice';
import {
  CameraIcon,
  CameraOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
} from '../../components/Icons';

function ControlButton({
  title,
  danger,
  off,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  off?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const color = danger
    ? 'bg-red-600 hover:bg-red-500 text-white'
    : off
      ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
      : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-12 w-12 items-center justify-center rounded-full ${color}`}
    >
      {children}
    </button>
  );
}

export function VoiceControls() {
  const micEnabled = useVoice((state) => state.micEnabled);
  const cameraEnabled = useVoice((state) => state.cameraEnabled);
  const deafened = useVoice((state) => state.deafened);
  const toggleMic = useVoice((state) => state.toggleMic);
  const toggleCamera = useVoice((state) => state.toggleCamera);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const leave = useVoice((state) => state.leave);

  return (
    <div className="flex shrink-0 items-center justify-center gap-3 bg-zinc-900/60 py-3">
      <ControlButton
        title={micEnabled ? 'Mutar microfone' : 'Ativar microfone'}
        off={!micEnabled}
        onClick={() => void toggleMic()}
      >
        {micEnabled ? <MicIcon /> : <MicOffIcon />}
      </ControlButton>
      <ControlButton
        title={cameraEnabled ? 'Desligar câmera' : 'Ligar câmera'}
        off={!cameraEnabled}
        onClick={() => void toggleCamera()}
      >
        {cameraEnabled ? <CameraIcon /> : <CameraOffIcon />}
      </ControlButton>
      <ControlButton
        title={deafened ? 'Ativar áudio' : 'Silenciar áudio'}
        off={deafened}
        onClick={() => void toggleDeafen()}
      >
        {deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
      </ControlButton>
      <ControlButton title="Sair do canal" danger onClick={() => void leave()}>
        <PhoneOffIcon />
      </ControlButton>
    </div>
  );
}
