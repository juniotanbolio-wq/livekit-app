import { useState } from 'react';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import {
  HeadphonesIcon,
  HeadphonesOffIcon,
  LogOutIcon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  MonitorOffIcon,
  SettingsIcon,
} from '../../components/Icons';
import { DeviceSettings } from '../voice/DeviceSettings';
import { useScreenShareToggle } from '../screen/useScreenShareToggle';

function PanelButton({
  title,
  active,
  live,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  live?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active ?? live}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent ${
        live ? 'text-emerald-400' : active ? 'text-red-400' : 'text-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}

export function UserPanel() {
  const user = useSession((state) => state.user);
  const logout = useSession((state) => state.logout);
  const micEnabled = useVoice((state) => state.micEnabled);
  const deafened = useVoice((state) => state.deafened);
  const toggleMic = useVoice((state) => state.toggleMic);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const screen = useScreenShareToggle();

  if (!user) {
    return null;
  }

  return (
    <>
      <div className="flex items-center gap-1 bg-zinc-950/60 px-2 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white uppercase">
          {user.username.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.username}</div>
          {user.isAdmin && <div className="text-[11px] text-zinc-500">admin</div>}
        </div>
        <PanelButton
          title={micEnabled ? 'Mutar microfone' : 'Ativar microfone'}
          active={!micEnabled}
          onClick={() => void toggleMic()}
        >
          {micEnabled ? <MicIcon size={18} /> : <MicOffIcon size={18} />}
        </PanelButton>
        <PanelButton
          title={deafened ? 'Ativar áudio' : 'Silenciar áudio'}
          active={deafened}
          onClick={() => void toggleDeafen()}
        >
          {deafened ? <HeadphonesOffIcon size={18} /> : <HeadphonesIcon size={18} />}
        </PanelButton>
        <PanelButton
          title={screen.title}
          live={screen.live}
          disabled={screen.disabled}
          onClick={screen.toggle}
        >
          {screen.live ? <MonitorOffIcon size={18} /> : <MonitorIcon size={18} />}
        </PanelButton>
        <PanelButton title="Dispositivos" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={18} />
        </PanelButton>
        <PanelButton title="Sair da conta" onClick={() => void logout()}>
          <LogOutIcon size={18} />
        </PanelButton>
      </div>
      {settingsOpen && <DeviceSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
