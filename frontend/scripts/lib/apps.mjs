// Instâncias reais do app para o aceite e a medição: Electron do projeto (out/, compilado) ou o .exe empacotado,
// cada uma com perfil próprio (--user-data-dir) e porta de CDP própria.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { Cdp } from './cdp.mjs';

export const frontendDir = fileURLToPath(new URL('../..', import.meta.url));

// Mídia falsa do Chromium. Além de câmera e microfone, ela troca a captura de tela por um padrão animado
// (o seletor continua listando as telas reais). Sem fps= a fonte falsa roda a 20 fps; pedimos 60 para o aceite
// exercitar a camada de 1080p60 (achado T4 da auditoria).
const FAKE_MEDIA_ARGS = [
  '--use-fake-device-for-media-stream=fps=60',
  '--use-fake-ui-for-media-stream',
];

export async function launchApp({
  name,
  port,
  userDataDir,
  serverUrl,
  exePath = null,
  extraArgs = [],
}) {
  const env = { ...process.env };
  // Variáveis que o ambiente do VS Code/Claude Code exporta e que mudariam o comportamento do Electron.
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const appArgs = [
    `--user-data-dir=${userDataDir}`,
    '--multi-instance',
    `--default-server-url=${serverUrl}`,
    ...extraArgs,
  ];
  const chromiumArgs = [`--remote-debugging-port=${port}`, ...FAKE_MEDIA_ARGS];
  const [command, args, cwd] = exePath
    ? [exePath, [...chromiumArgs, ...appArgs], undefined]
    : [electronPath, [...chromiumArgs, '.', ...appArgs], frontendDir];
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { name, port, child, log: [], cdp: null };
  const collect = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) {
        app.log.push(line);
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  app.cdp = await Cdp.connect(port);
  return app;
}

export function killApp(app) {
  app.cdp?.close();
  if (app.child.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      app.child.kill('SIGKILL');
    }
  }
}

// Simula o clique no X: manda WM_CLOSE para a janela do processo principal. (window.close() pelo renderer
// fecha a janela direto, sem o evento `close` que o app usa para esconder na bandeja.)
export function postWindowClose(app) {
  const script = [
    `$h = (Get-Process -Id ${app.child.pid}).MainWindowHandle`,
    'if ($h -eq 0) { exit 2 }',
    `Add-Type -Name Win -Namespace E2e -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'`,
    'if (-not [E2e.Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 3 }',
  ].join('; ');
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
}

// Visível para o Windows? (document.visibilityState não serve: com backgroundThrottling desligado o
// Chromium sempre informa "visible".) MainWindowHandle só aponta para janelas visíveis.
export function windowVisible(app) {
  const out = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${app.child.pid}).MainWindowHandle`,
    ],
    { encoding: 'utf8' },
  );
  return out.trim() !== '0';
}

export async function screenshot(app, dir, label) {
  if (!dir) {
    return;
  }
  try {
    const { data } = await app.cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${label}-${app.name}.png`), Buffer.from(data, 'base64'));
  } catch (err) {
    console.log(`  (captura ${label} de ${app.name} falhou: ${err.message})`);
  }
}

// WAV PCM 16 bits mono 48 kHz com uma senoide de 440 Hz no nível pedido (RMS em dBFS). Usado com
// --use-file-for-fake-audio-capture: o microfone falso padrão do Chromium é um bipe curto quase no volume máximo,
// que não deixa medir nível nem o noise gate de forma determinística; um tom constante deixa.
export async function writeToneWav(path, levelDb, seconds = 2) {
  const rate = 48_000;
  const frames = rate * seconds;
  const amplitude = 10 ** (levelDb / 20) * Math.SQRT2;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + frames * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // tamanho do bloco fmt
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // bytes por segundo
  wav.writeUInt16LE(2, 32); // bytes por quadro
  wav.writeUInt16LE(16, 34); // bits por amostra
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const sample = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate);
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  await writeFile(path, wav);
  return path;
}

// Linhas de erro do log de uma instância (impressas no fim quando algo falha).
export function errorLines(app, max = 15) {
  return app.log.filter((line) => /error|erro|falha/i.test(line)).slice(-max);
}
