// Aceite da fase R2: duas instâncias reais do app (compilado, origem app://desktop) dirigidas por CDP,
// com câmera e microfone falsos do Chromium, contra o Compose de desenvolvimento (infra/docker-compose.yml).
//
//   cd infra; docker compose up -d --build; docker compose exec backend /server seed
//   cd frontend; npm run e2e                  (compila antes; --no-build pula a compilação)
//   npm run e2e -- --screenshots <pasta>      (salva capturas de tela das etapas principais)
//
// --use-fake-device-for-media-stream também troca a captura de tela pelo padrão animado do Chromium
// (1920x1080 a 60 fps): o seletor lista as telas reais desta máquina, mas o vídeo publicado é o falso.
// O script reinicia o contêiner do backend (etapa de reconexão) e deixa usuários e2e_* no banco de dev.
import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import electronPath from 'electron';

const execFileAsync = promisify(execFile);
const frontendDir = fileURLToPath(new URL('..', import.meta.url));
const composeFile = fileURLToPath(new URL('../../infra/docker-compose.yml', import.meta.url));
const SERVER_URL = 'http://localhost:8080';
const CHANNEL_ID = 'voice-1';
const args = process.argv.slice(2);
const screenshotsDir = args.includes('--screenshots')
  ? args[args.indexOf('--screenshots') + 1]
  : null;

// ---------- resultado ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const mark = ok ? '\x1b[32m  PASSOU\x1b[0m' : '\x1b[31m  FALHOU\x1b[0m';
  console.log(`${mark}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
function note(name, detail) {
  results.push({ name, ok: true, skipped: true });
  console.log(`\x1b[33m  NÃO TESTÁVEL\x1b[0m  ${name}  (${detail})`);
}
function section(title) {
  console.log(`\n\x1b[36m=== ${title} ===\x1b[0m`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 15_000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) {
        return last;
      }
    } catch {
      last = undefined;
    }
    await sleep(interval);
  }
  return last ?? false;
}

// ---------- Docker / backend ----------
function compose(...composeArgs) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...composeArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createInvite() {
  const out = compose('exec', '-T', 'backend', '/server', 'invite', 'create', '--hours', '1');
  const match = /Código de convite:\s*(\S+)/.exec(out);
  if (!match) {
    throw new Error(`não achei o código no retorno do invite create: ${out}`);
  }
  return match[1];
}

function backendLogsSince(since) {
  return compose('logs', '--no-color', '--since', since, 'backend');
}

async function health() {
  try {
    const response = await fetch(`${SERVER_URL}/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// ---------- CDP ----------
class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(port) {
    const page = await waitFor(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((target) => target.type === 'page' && target.url.startsWith('app://'));
      },
      { timeout: 30_000, interval: 300 },
    );
    if (!page) {
      throw new Error(`a janela do app não apareceu no CDP da porta ${port}`);
    }
    const cdp = new Cdp();
    await cdp.#open(page.webSocketDebuggerUrl);
    return cdp;
  }

  #open(url) {
    return new Promise((resolve, reject) => {
      this.#socket = new WebSocket(url);
      this.#socket.onopen = () => resolve();
      this.#socket.onerror = () => reject(new Error('falha ao conectar no CDP'));
      this.#socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const entry = this.#pending.get(message.id);
        if (entry) {
          this.#pending.delete(message.id);
          if (message.error) {
            entry.reject(new Error(message.error.message));
          } else {
            entry.resolve(message.result);
          }
        }
      };
      this.#socket.onclose = () => {
        for (const entry of this.#pending.values()) {
          entry.reject(new Error('CDP desconectado'));
        }
        this.#pending.clear();
      };
    });
  }

  // Com prazo: se a instância morrer no meio do teste, a etapa falha em vez de travar o script.
  send(method, params = {}) {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP desconectado'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP sem resposta para ${method}`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  // Avalia uma expressão na página com os auxiliares de DOM abaixo disponíveis.
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${PAGE_HELPERS}; return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'erro na página');
    }
    return result.result.value;
  }

  close() {
    this.#socket?.close();
  }
}

// Executados dentro da página. fill usa o setter nativo para o React enxergar a mudança do input.
const PAGE_HELPERS = `
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const exists = (s) => $(s) !== null;
  const text = (s) => $(s)?.textContent?.trim() ?? null;
  const click = (s) => { const el = $(s); if (!el) return false; el.click(); return true; };
  const clickText = (s, t) => { const el = $$(s).find((e) => e.textContent.trim() === t); if (!el) return false; el.click(); return true; };
  const fill = (s, v) => {
    const el = $(s); if (!el) return false;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const submit = (s) => { const el = $(s); if (!el) return false; el.requestSubmit(); return true; };
  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  const attr = (v) => JSON.stringify(String(v));
`;

// ---------- instâncias do app ----------
let tempRoot;
const apps = [];

async function launchApp(name, port) {
  const userData = join(tempRoot, name);
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronPath,
    [
      `--remote-debugging-port=${port}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '.',
      `--user-data-dir=${userData}`,
      '--multi-instance',
    ],
    { cwd: frontendDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
  apps.push(app);
  app.cdp = await Cdp.connect(port);
  return app;
}

// Simula o clique no X: manda WM_CLOSE para a janela do processo principal. (window.close() pelo renderer
// fecha a janela direto, sem o evento `close` que o app usa para esconder na bandeja.)
function postWindowClose(app) {
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
function windowVisible(app) {
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

function notificationCount(app) {
  return app.log.filter((line) => line.includes('notificação de menção exibida')).length;
}

function killApp(app) {
  app.cdp?.close();
  if (app.child.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      app.child.kill('SIGKILL');
    }
  }
}

async function screenshot(app, label) {
  if (!screenshotsDir) {
    return;
  }
  try {
    const { data } = await app.cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, `${label}-${app.name}.png`), Buffer.from(data, 'base64'));
  } catch (err) {
    console.log(`  (captura ${label} de ${app.name} falhou: ${err.message})`);
  }
}

// ---------- etapas ----------
async function setupServer(app, { tryInvalid }) {
  const { cdp } = app;
  check(
    `${app.name}: primeira execução pede o servidor`,
    await waitFor(() => cdp.eval(`exists('[data-screen="server-setup"]')`)),
  );
  const prefilled = await cdp.eval(`$('#serverUrl')?.value`);
  check(`${app.name}: endereço padrão de dev pré-preenchido`, prefilled === SERVER_URL, prefilled);
  if (tryInvalid) {
    await cdp.eval(`fill('#serverUrl', 'http://localhost:9') && submit('[data-server-form]')`);
    const error = await waitFor(() => cdp.eval(`text('[data-server-error]')`), { timeout: 10_000 });
    check(`${app.name}: endereço sem servidor mostra erro`, Boolean(error), error || 'sem erro');
    await cdp.eval(`fill('#serverUrl', 'http://exemplo.com') && submit('[data-server-form]')`);
    const tlsError = await waitFor(
      () =>
        cdp.eval(
          `text('[data-server-error]')?.includes('TLS') ? text('[data-server-error]') : null`,
        ),
      { timeout: 5_000 },
    );
    check(
      `${app.name}: http:// fora do localhost é recusado`,
      Boolean(tlsError),
      tlsError || 'sem erro',
    );
  }
  await cdp.eval(
    `fill('#serverUrl', ${JSON.stringify(SERVER_URL)}) && submit('[data-server-form]')`,
  );
  const shown = await waitFor(() =>
    cdp.eval(`exists('[data-screen="auth"]') && text('[data-current-server]')`),
  );
  mustPass(
    `${app.name}: servidor validado (GET /health) e salvo`,
    shown === SERVER_URL,
    String(shown),
  );
}

async function register(app, inviteCode, username, password) {
  const { cdp } = app;
  await cdp.eval(`clickText('[data-screen="auth"] button', 'Cadastre-se')`);
  await waitFor(() => cdp.eval(`exists('#inviteCode')`));
  await cdp.eval(
    `fill('#inviteCode', ${JSON.stringify(inviteCode)}) && fill('#username', ${JSON.stringify(username)}) && fill('#password', ${JSON.stringify(password)}) && fill('#confirm', ${JSON.stringify(password)}) && submit('[data-screen="auth"] form')`,
  );
  return authOutcome(app);
}

async function login(app, username, password) {
  const { cdp } = app;
  await cdp.eval(
    `fill('#username', ${JSON.stringify(username)}) && fill('#password', ${JSON.stringify(password)}) && submit('[data-screen="auth"] form')`,
  );
  return authOutcome(app);
}

// Entrou (WebSocket conectado) ou a tela mostrou um erro. O backend de dev limita cadastro + login a 10 por
// 15 min por IP: rodar o teste muitas vezes seguidas esbarra nisso (o erro aparece aqui).
async function authOutcome(app) {
  const outcome = await waitFor(
    () =>
      app.cdp.eval(`exists('[data-realtime-status="connected"]')
        ? { ok: true }
        : exists('[data-screen="auth"] [role="alert"]') ? { ok: false, error: text('[data-screen="auth"] [role="alert"]') } : null`),
    { timeout: 20_000 },
  );
  return outcome || { ok: false, error: 'sem resposta em 20 s' };
}

// Etapa da qual as seguintes dependem: se falhar, o teste para em vez de acumular falhas em cascata.
function mustPass(name, ok, detail) {
  if (!check(name, ok, detail)) {
    throw new Error(`etapa obrigatória falhou: ${name}`);
  }
}

// 'live' = participante da minha sala LiveKit; 'presence' = presença vinda do WebSocket.
function rowSelector(kind, username) {
  return `[data-${kind}-user=${JSON.stringify(username)}]`;
}

// Abre o diálogo de "chamar atenção" pela linha da pessoa e envia; devolve 'sent' ou o texto do erro.
async function mention(app, targetName, message) {
  const { cdp } = app;
  const button = `[data-mention-target=${JSON.stringify(targetName)}]`;
  const opened = await waitFor(() => cdp.eval(`click(${JSON.stringify(button)})`), {
    timeout: 10_000,
  });
  if (!opened) {
    return { outcome: 'no-button' };
  }
  const dialog = `[data-mention-dialog=${JSON.stringify(targetName)}]`;
  await waitFor(() => cdp.eval(`exists(${JSON.stringify(dialog)})`));
  await cdp.eval(
    `fill('#mentionMessage', ${JSON.stringify(message ?? '')}) && submit(${JSON.stringify(dialog)})`,
  );
  const outcome = await waitFor(
    () =>
      cdp.eval(`(() => {
        const status = $(${JSON.stringify(dialog)})?.dataset.mentionStatus;
        if (status === 'sent') return { outcome: 'sent' };
        if (status === 'error') return { outcome: 'error', error: text('[data-mention-error]') };
        return null;
      })()`),
    { timeout: 15_000 },
  );
  await cdp.eval(`key('Escape')`);
  await waitFor(() => cdp.eval(`!exists(${JSON.stringify(dialog)})`), { timeout: 3_000 });
  return outcome || { outcome: 'timeout' };
}

async function debugRows(app, section) {
  return app.cdp
    .eval(`$$('[data-debug-section="${section}"] [data-debug-remote] tr[data-source]').map((row) => ({
    source: row.dataset.source,
    subscribed: row.dataset.subscribed === 'true',
  }))`);
}

async function main() {
  section('Preparação');
  if (!args.includes('--no-build')) {
    console.log('Compilando o app (npm run build)...');
    execSync('npm run build', { cwd: frontendDir, stdio: 'ignore' });
  }
  if (!existsSync(join(frontendDir, 'out', 'main', 'index.js'))) {
    throw new Error('out/ não encontrado: rode npm run build');
  }
  const healthBody = await health();
  if (
    !check(
      'backend do Compose respondendo em /health',
      healthBody?.status === 'ok',
      JSON.stringify(healthBody),
    )
  ) {
    throw new Error('suba o Compose de dev (infra) antes do teste');
  }
  check(
    'GET /health devolve livekitUrl',
    typeof healthBody.livekitUrl === 'string',
    healthBody.livekitUrl,
  );

  const suffix = Date.now().toString(36);
  const users = {
    A: { name: `e2e_a_${suffix}`, password: `senha-a-${suffix}` },
    B: { name: `e2e_b_${suffix}`, password: `senha-b-${suffix}` },
  };
  const invites = [createInvite(), createInvite()];
  check(
    'convites gerados pelo backend Go (server invite create)',
    invites.every((code) => code.length >= 8),
  );

  tempRoot = await mkdtemp(join(tmpdir(), 'livekit-e2e-'));
  const A = await launchApp('A', 9311);
  const B = await launchApp('B', 9312);

  section('1. Endereço do servidor');
  await setupServer(A, { tryInvalid: true });
  await setupServer(B, { tryInvalid: false });

  section('2. Cadastro e WebSocket');
  const regA = await register(A, invites[0], users.A.name, users.A.password);
  mustPass(`A cadastrado (${users.A.name}) e WebSocket conectado`, regA.ok, regA.error);
  const regB = await register(B, invites[1], users.B.name, users.B.password);
  mustPass(`B cadastrado (${users.B.name}) e WebSocket conectado`, regB.ok, regB.error);

  section('3. Sessão expirada (401) volta ao login');
  // O reload é adiado para a avaliação terminar antes de o contexto da página ser destruído.
  await B.cdp.eval(
    `window.desktop.setSession(JSON.stringify({ token: 'token-invalido', user: { id: 'x', username: 'x', isAdmin: false, createdAt: '2026-01-01T00:00:00Z' } })).then(() => { setTimeout(() => location.reload(), 100); return true; })`,
  );
  const expired = await waitFor(() =>
    B.cdp.eval(`exists('[data-screen="auth"]') && document.body.textContent.includes('expirou')`),
  );
  check('B: token inválido + reinício -> login com aviso de sessão expirada', Boolean(expired));
  const loginB = await login(B, users.B.name, users.B.password);
  mustPass('B: login com usuário e senha', loginB.ok, loginB.error);

  section('4. Voz e presença pelo WebSocket');
  await A.cdp.eval(`click('[data-channel-id="${CHANNEL_ID}"]')`);
  mustPass(
    'A entrou na voz do canal',
    await waitFor(
      () => A.cdp.eval(`exists(${JSON.stringify(rowSelector('live', users.A.name))})`),
      { timeout: 20_000 },
    ),
  );
  check(
    'B vê A no canal pela presença do WebSocket',
    await waitFor(
      () =>
        B.cdp.eval(
          `exists('[data-channel-block="${CHANNEL_ID}"] ' + ${JSON.stringify(rowSelector('presence', users.A.name))})`,
        ),
      { timeout: 15_000 },
    ),
  );

  section('5. Transmissão aparece AO VIVO');
  await A.cdp.eval(`click('button[title="Compartilhar a tela"]')`);
  const source = await waitFor(
    () => A.cdp.eval(`$('[data-source-id^="screen:"]')?.dataset.sourceId ?? null`),
    { timeout: 15_000 },
  );
  check('A: seletor listou uma tela', Boolean(source), String(source));
  await A.cdp.eval(
    `click('[data-source-id^="screen:"]') && clickText('[role="dialog"] button', 'Compartilhar')`,
  );
  mustPass(
    'A: tela publicada (1080p60 padrão)',
    await waitFor(() => A.cdp.eval(`exists('button[title="Parar de compartilhar a tela"]')`), {
      timeout: 20_000,
    }),
  );
  check(
    'B vê o canal AO VIVO na barra lateral (WebSocket)',
    await waitFor(
      () =>
        B.cdp.eval(
          `exists('[data-channel-id="${CHANNEL_ID}"][data-live="true"]') && exists(${JSON.stringify(`${rowSelector('presence', users.A.name)}[data-sharing="true"]`)})`,
        ),
      { timeout: 15_000 },
    ),
  );
  await screenshot(B, '05-ao-vivo');

  section('6. Modo Espectador assina só a tela');
  await B.cdp.eval(`click('[data-channel-id="${CHANNEL_ID}"]')`);
  await waitFor(() => B.cdp.eval(`clickText('button', 'Assistir transmissão')`));
  check(
    'B em modo espectador',
    await waitFor(() => B.cdp.eval(`exists('[data-watch-mode="spectator"]')`)),
  );
  await B.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  const inbound = await waitFor(
    () =>
      B.cdp.eval(
        `(() => { const t = text('[data-debug-section="Espectador"] [data-debug-inbound="screen_share"]'); return t && /\\d+x\\d+/.test(t) && !/-x-/.test(t) ? t : null; })()`,
      ),
    { timeout: 30_000, interval: 500 },
  );
  check('B recebe o vídeo da tela', Boolean(inbound), inbound || 'sem estatísticas');
  const spectatorRows = await debugRows(B, 'Espectador');
  const subscribed = spectatorRows.filter((row) => row.subscribed).map((row) => row.source);
  check(
    'Espectador assinou só screen_share',
    subscribed.length === 1 && subscribed[0] === 'screen_share',
    `assinadas: ${subscribed.join(', ') || 'nenhuma'}`,
  );
  check(
    'Espectador não assinou o microfone de A',
    spectatorRows.some((row) => row.source === 'microphone' && !row.subscribed),
    JSON.stringify(spectatorRows),
  );
  // O simulcast começa na camada baixa e sobe conforme a estimativa de banda; o espectador pede a HIGH.
  // O fps depende do que muda na tela (desktop parado gera poucos quadros), então só é registrado.
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  let best = null;
  const full = await waitFor(
    async () => {
      const seen = await B.cdp.eval(`(() => {
        const t = text('[data-debug-section="Espectador"] [data-debug-inbound="screen_share"]');
        const m = t && /(\\d+)x(\\d+) @ (\\S+) fps/.exec(t);
        return m ? { width: Number(m[1]), label: m[0] } : null;
      })()`);
      if (seen && (!best || seen.width >= best.width)) {
        best = seen;
      }
      return seen?.width >= 1920;
    },
    { timeout: 45_000, interval: 500 },
  );
  check(
    'B recebe a camada alta da tela (≥ 1280 px de largura)',
    (best?.width ?? 0) >= 1280,
    best?.label ?? 'sem estatísticas',
  );
  check('B recebe a tela em 1080p (camada f)', Boolean(full), best?.label ?? 'sem estatísticas');
  const sent = await waitFor(() =>
    A.cdp.eval(`(() => {
      const capture = text('[data-debug-section="Voz"] [data-debug-capture]');
      const layers = $$('[data-debug-section="Voz"] [data-debug-outbound] tr[data-rid]').map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(' '));
      const limits = $$('[data-debug-section="Voz"] p').find((p) => p.textContent.includes('limitação'))?.textContent.trim();
      return capture && layers.length > 0 ? capture + ' | camadas: ' + layers.join(' ; ') + ' | ' + limits : null;
    })()`),
  );
  check('A: captura e camadas de simulcast publicadas', Boolean(sent), sent || 'sem estatísticas');
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  await screenshot(B, '06-espectador');

  section('7. B entra na voz');
  await B.cdp.eval(`click('button[title="Entrar na voz deste canal"]')`);
  check(
    'B conectado na voz',
    await waitFor(
      () => B.cdp.eval(`exists('[data-debug-section="Voz"] [data-debug-state="connected"]')`),
      { timeout: 20_000 },
    ),
  );
  check(
    'conexão de espectador encerrada (a voz cobre o canal)',
    await waitFor(
      () =>
        B.cdp.eval(`exists('[data-debug-section="Espectador"] [data-debug-state="disconnected"]')`),
      { timeout: 15_000 },
    ),
  );
  const voiceRows = await waitFor(async () => {
    const rows = await debugRows(B, 'Voz');
    return rows.some((row) => row.source === 'microphone' && row.subscribed) ? rows : null;
  });
  check('B ouve A (microfone assinado na voz)', Boolean(voiceRows), JSON.stringify(voiceRows));
  check(
    'A vê B na sala de voz',
    await waitFor(
      () => A.cdp.eval(`exists(${JSON.stringify(rowSelector('live', users.B.name))})`),
      { timeout: 15_000 },
    ),
  );
  await B.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);

  section('8. Chamar atenção nos dois sentidos');
  const beforeA = notificationCount(A);
  const sentBA = await mention(B, users.A.name, 'e2e: oi A');
  check('B -> A: confirmado pelo servidor', sentBA.outcome === 'sent', JSON.stringify(sentBA));
  const toastA = await waitFor(() =>
    A.cdp.eval(
      `text(${JSON.stringify(`[data-mention-toast=${JSON.stringify(users.B.name)}] [data-mention-message]`)})`,
    ),
  );
  check('A: aviso no app com a mensagem', String(toastA).includes('e2e: oi A'), String(toastA));
  check(
    'A: notificação do Windows exibida',
    await waitFor(() => notificationCount(A) > beforeA, { timeout: 10_000 }),
  );
  await screenshot(A, '08-mencao-recebida');
  const beforeB = notificationCount(B);
  const sentAB = await mention(A, users.B.name, null);
  check(
    'A -> B (sem mensagem): confirmado pelo servidor',
    sentAB.outcome === 'sent',
    JSON.stringify(sentAB),
  );
  check(
    'B: aviso no app',
    await waitFor(() =>
      B.cdp.eval(
        `exists(${JSON.stringify(`[data-mention-toast=${JSON.stringify(users.A.name)}]`)})`,
      ),
    ),
  );
  check(
    'B: notificação do Windows exibida',
    await waitFor(() => notificationCount(B) > beforeB, { timeout: 10_000 }),
  );

  section('9. Bandeja');
  postWindowClose(B);
  await sleep(1500);
  check('B: fechar a janela não encerra o app', B.child.exitCode === null);
  check('B: janela escondida (sem janela visível no Windows)', !windowVisible(B));
  const beforeTray = notificationCount(B);
  const trayMention = await mention(A, users.B.name, 'e2e: na bandeja');
  check(
    'A -> B com B na bandeja: entregue',
    trayMention.outcome === 'sent',
    JSON.stringify(trayMention),
  );
  check(
    'B (na bandeja): notificação do Windows exibida',
    await waitFor(() => notificationCount(B) > beforeTray, { timeout: 10_000 }),
  );

  section('10. Reinício do backend');
  // B sai da voz: assim a barra lateral dele mostra a presença vinda do WebSocket (e não a da sala LiveKit).
  await B.cdp.eval(`click('button[title="Sair do canal de voz"]')`);
  await waitFor(
    () =>
      B.cdp.eval(
        `exists(${JSON.stringify(`${rowSelector('presence', users.A.name)}[data-sharing="true"]`)})`,
      ),
    { timeout: 15_000 },
  );
  const seen = { A: new Set(), B: new Set() };
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      for (const [name, app] of [
        ['A', A],
        ['B', B],
      ]) {
        const status = await app.cdp
          .eval(`$('[data-realtime-status]')?.dataset.realtimeStatus ?? null`)
          .catch(() => null);
        if (status) {
          seen[name].add(status);
        }
      }
      await sleep(100);
    }
  })();
  const restartedAt = new Date().toISOString();
  await execFileAsync('docker', ['compose', '-f', composeFile, 'restart', 'backend']);
  const back = await waitFor(
    async () =>
      (await A.cdp.eval(`exists('[data-realtime-status="connected"]')`)) &&
      (await B.cdp.eval(`exists('[data-realtime-status="connected"]')`)) &&
      seen.A.has('reconnecting') &&
      seen.B.has('reconnecting'),
    { timeout: 60_000, interval: 300 },
  );
  watching = false;
  await watcher;
  check(
    'A e B mostraram "Reconectando..." e voltaram',
    Boolean(back),
    `A: ${[...seen.A]} · B: ${[...seen.B]}`,
  );
  const reconnects = backendLogsSince(restartedAt)
    .split('\n')
    .filter((line) => line.includes('websocket conectado')).length;
  check('dois WebSockets reconectados no backend novo', reconnects >= 2, `${reconnects} conexões`);
  check(
    'presença correta depois: B vê A no canal, transmitindo',
    await waitFor(
      () =>
        B.cdp.eval(
          `exists('[data-channel-id="${CHANNEL_ID}"][data-live="true"]') && exists(${JSON.stringify(`${rowSelector('presence', users.A.name)}[data-sharing="true"]`)})`,
        ),
      { timeout: 30_000 },
    ),
  );
  await A.cdp.eval(`click('button[title="Parar de compartilhar a tela"]')`);
  check(
    'eventos seguem chegando: A parou a tela e B viu',
    await waitFor(
      () =>
        B.cdp.eval(
          `exists('[data-channel-id="${CHANNEL_ID}"][data-live="false"]') && exists(${JSON.stringify(`${rowSelector('presence', users.A.name)}[data-sharing="false"]`)})`,
        ),
      { timeout: 15_000 },
    ),
  );

  section('11. Limite de chamadas');
  let limited = null;
  for (let i = 0; i < 7 && !limited; i++) {
    const result = await mention(B, users.A.name, `e2e: limite ${i + 1}`);
    if (result.outcome === 'error') {
      limited = { attempt: i + 1, error: result.error };
    } else if (result.outcome !== 'sent') {
      break;
    }
  }
  check(
    'B -> A repetido: erro claro de limite',
    Boolean(limited?.error?.includes('Limite atingido')),
    limited ? `tentativa ${limited.attempt}: ${limited.error}` : 'sem erro de limite',
  );

  section('12. Destinatário offline');
  // B ainda está assistindo o canal (voltou ao espectador ao sair da voz): entra pela tela da transmissão.
  await B.cdp.eval(`click('button[title="Entrar na voz deste canal"]')`);
  const bInVoice = await waitFor(
    () => A.cdp.eval(`exists(${JSON.stringify(rowSelector('live', users.B.name))})`),
    { timeout: 20_000 },
  );
  if (!bInVoice) {
    note('A -> B offline', 'B não voltou para a voz');
  } else {
    // Encerrado à força, B some do WebSocket na hora, mas o LiveKit ainda o mantém na sala por alguns segundos.
    killApp(B);
    await sleep(1500);
    const offline = await mention(A, users.B.name, 'e2e: offline');
    if (offline.outcome === 'no-button') {
      note('A -> B offline', 'B saiu da sala antes do teste');
    } else {
      check(
        'A -> B encerrado: erro claro de offline',
        offline.outcome === 'error' && /offline/.test(offline.error ?? ''),
        JSON.stringify(offline),
      );
    }
  }

  section('13. Sair fecha o WebSocket');
  const session = JSON.parse(await A.cdp.eval(`window.desktop.getSession()`));
  const logoutAt = new Date().toISOString();
  await A.cdp.eval(`click('button[title="Sair da conta"]')`);
  check(
    'A: tela de login após sair',
    await waitFor(() => A.cdp.eval(`exists('[data-screen="auth"]')`)),
  );
  const closed = await waitFor(
    () =>
      backendLogsSince(logoutAt)
        .split('\n')
        .some((line) => line.includes('websocket desconectado') && line.includes(session.user.id)),
    { timeout: 10_000, interval: 500 },
  );
  check('backend registrou o WebSocket de A fechado', Boolean(closed));
  await sleep(3000);
  const reopened = backendLogsSince(logoutAt)
    .split('\n')
    .some((line) => line.includes('websocket conectado') && line.includes(session.user.id));
  check('A não reconecta depois de sair', !reopened);
}

let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err;
  console.error(
    `\n\x1b[31mInterrompido: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
  );
} finally {
  for (const app of apps) {
    killApp(app);
  }
  if (tempRoot) {
    await sleep(500);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const failed = results.filter((item) => !item.ok);
const skipped = results.filter((item) => item.skipped);
console.log(`\n\x1b[36m=== Resumo ===\x1b[0m`);
console.log(
  `${results.length - failed.length - skipped.length} passaram, ${failed.length} falharam, ${skipped.length} não testáveis`,
);
for (const item of failed) {
  console.log(`  FALHOU  ${item.name}`);
}
if (screenshotsDir) {
  console.log(`Capturas em ${screenshotsDir}`);
}
for (const app of apps) {
  const errors = app.log.filter((line) => /error|erro|falha/i.test(line));
  if (errors.length > 0 && (failed.length > 0 || fatal)) {
    console.log(`\nLog de ${app.name} (linhas com erro):\n  ${errors.slice(-15).join('\n  ')}`);
  }
}
process.exit(failed.length === 0 && !fatal ? 0 : 1);
