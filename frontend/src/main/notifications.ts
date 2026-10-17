import { Notification, type BrowserWindow } from 'electron';
import type { MentionNotice } from '../shared/desktop-api';

// Referências vivas até o usuário interagir: sem isso o coletor de lixo pode descartar a notificação e o
// clique nela deixa de abrir a janela.
const active = new Set<Notification>();
// Janelas piscando à espera de foco: um só listener por janela, mesmo com várias menções seguidas.
const flashing = new WeakSet<BrowserWindow>();

// Toast do Windows para "chamar atenção". silent:false = som padrão de notificação do sistema, que o
// usuário controla nas configurações do Windows (inclusive o "não perturbe").
export function showMentionNotification(
  notice: MentionNotice,
  window: BrowserWindow | null,
  openWindow: () => void,
): void {
  if (window && !window.isDestroyed() && !window.isFocused() && !flashing.has(window)) {
    // Pisca o botão da barra de tarefas até a janela ganhar foco.
    flashing.add(window);
    window.flashFrame(true);
    window.once('focus', () => {
      flashing.delete(window);
      window.flashFrame(false);
    });
  }
  if (!Notification.isSupported()) {
    console.warn('Notificações do sistema indisponíveis; a menção aparece só dentro do app');
    return;
  }
  const notification = new Notification({
    title: `${notice.from} está chamando você`,
    body: notice.message ?? 'Chamou sua atenção.',
    silent: false,
  });
  const release = () => active.delete(notification);
  active.add(notification);
  notification.on('show', () => {
    // Linha usada pelo teste de aceite (scripts/e2e.mjs) para confirmar o toast.
    console.info('notificação de menção exibida');
  });
  notification.on('click', () => {
    release();
    openWindow();
  });
  notification.on('close', release);
  notification.on('failed', (_event, error) => {
    release();
    console.error('Falha ao exibir a notificação:', error);
  });
  notification.show();
}
