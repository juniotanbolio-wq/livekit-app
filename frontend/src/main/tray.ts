import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

const ICON_PX = 32;
// Indigo do tema (#4f46e5) com um ponto branco no centro.
const DISC = { r: 0x4f, g: 0x46, b: 0xe5 };

// Ícone provisório desenhado em código (a R4 traz o ícone de verdade, junto com o do executável).
// Bitmap BGRA com alfa pré-multiplicado, o formato nativo do Skia; a borda é suavizada pela cobertura.
function createTrayIcon(): NativeImage {
  const buffer = Buffer.alloc(ICON_PX * ICON_PX * 4);
  const center = (ICON_PX - 1) / 2;
  const radius = ICON_PX / 2 - 1;
  const dot = ICON_PX / 6;
  for (let y = 0; y < ICON_PX; y++) {
    for (let x = 0; x < ICON_PX; x++) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = Math.min(1, Math.max(0, radius - distance + 0.5));
      if (alpha === 0) {
        continue;
      }
      const white = Math.min(1, Math.max(0, dot - distance + 0.5));
      const r = DISC.r + (255 - DISC.r) * white;
      const g = DISC.g + (255 - DISC.g) * white;
      const b = DISC.b + (255 - DISC.b) * white;
      const offset = (y * ICON_PX + x) * 4;
      buffer[offset] = Math.round(b * alpha);
      buffer[offset + 1] = Math.round(g * alpha);
      buffer[offset + 2] = Math.round(r * alpha);
      buffer[offset + 3] = Math.round(alpha * 255);
    }
  }
  // 32 px em escala 2 = ícone de 16 px lógicos, nítido também em telas com zoom de 200%.
  return nativeImage.createFromBitmap(buffer, { width: ICON_PX, height: ICON_PX, scaleFactor: 2 });
}

export interface TrayActions {
  open(): void;
  quit(): void;
}

// Ícone da bandeja: com a janela fechada (escondida), é por aqui que o usuário volta ao app ou sai de vez.
export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('LiveKit App');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: actions.open },
      { type: 'separator' },
      { label: 'Sair', click: actions.quit },
    ]),
  );
  tray.on('click', actions.open);
  return tray;
}
