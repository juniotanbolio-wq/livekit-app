import { useScreenShare } from '../../stores/screen-share';
import { useVoice } from '../../stores/voice';

export interface ScreenShareToggle {
  live: boolean;
  starting: boolean;
  disabled: boolean;
  title: string;
  toggle(): void;
}

export function useScreenShareToggle(): ScreenShareToggle {
  const status = useScreenShare((state) => state.status);
  const openPicker = useScreenShare((state) => state.openPicker);
  const stop = useScreenShare((state) => state.stop);
  const inVoice = useVoice((state) => state.connection === 'connected');

  const live = status === 'live';
  const starting = status === 'starting';
  const disabled = !live && (!inVoice || starting);

  return {
    live,
    starting,
    disabled,
    title: live
      ? 'Parar de compartilhar a tela'
      : inVoice
        ? 'Compartilhar a tela'
        : 'Entre em um canal de voz para compartilhar a tela',
    toggle() {
      if (live) {
        void stop();
      } else if (!disabled) {
        openPicker();
      }
    },
  };
}
