// Aceite do frontend (R2 + Fase Q): duas instâncias reais do app (compilado, origem app://desktop) dirigidas por
// CDP, com câmera, microfone e tela falsos do Chromium, contra um servidor DESCARTÁVEL (scripts/lib/stack.mjs):
// LiveKit e backend em contêineres próprios, portas 27880-27882 e 28080, segredos desta execução. O ambiente de
// desenvolvimento (Compose de infra/, banco e infra/.env) não é tocado.
//
//   cd frontend; npm run e2e                  (compila antes; --no-build pula a compilação)
//   npm run e2e -- --exe <caminho do .exe>    (mesmo aceite no app empacotado; não compila)
//   npm run e2e -- --screenshots <pasta>      (salva capturas de tela das etapas principais)
//
// Pré-requisito: Docker Desktop em execução. Tudo o que o teste cria é removido no final, inclusive com Ctrl+C.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  errorLines,
  frontendDir,
  killApp,
  launchApp,
  postWindowClose,
  screenshot as captureScreenshot,
  windowVisible,
  writeToneWav,
} from './lib/apps.mjs';
import { createReporter, sleep, waitFor } from './lib/harness.mjs';
import { cleanupOnSignal, startStack } from './lib/stack.mjs';

const CHANNEL_ID = 'voice-1';
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}
const screenshotsDir = argValue('--screenshots');
const exePath = argValue('--exe') ? resolve(argValue('--exe')) : null;

const reporter = createReporter();
const { check, note, mustPass, section } = reporter;

let stack = null;
let tempRoot = null;
const apps = [];

async function screenshot(app, label) {
  await captureScreenshot(app, screenshotsDir, label);
}

function notificationCount(app) {
  return app.log.filter((line) => line.includes('notificação de menção exibida')).length;
}

// ---------- etapas ----------
async function setupServer(app, { tryInvalid }) {
  const { cdp } = app;
  check(
    `${app.name}: primeira execução pede o servidor`,
    await waitFor(() => cdp.eval(`exists('[data-screen="server-setup"]')`)),
  );
  const prefilled = await cdp.eval(`$('#serverUrl')?.value`);
  check(
    `${app.name}: endereço sugerido por --default-server-url`,
    prefilled === stack.serverUrl,
    prefilled,
  );
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
    `fill('#serverUrl', ${JSON.stringify(stack.serverUrl)}) && submit('[data-server-form]')`,
  );
  const shown = await waitFor(() =>
    cdp.eval(`exists('[data-screen="auth"]') && text('[data-current-server]')`),
  );
  mustPass(
    `${app.name}: servidor validado (GET /health) e salvo`,
    shown === stack.serverUrl,
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

// Entrou (WebSocket conectado) ou a tela mostrou um erro.
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

async function debugRows(app, sectionName) {
  return app.cdp
    .eval(`$$('[data-debug-section="${sectionName}"] [data-debug-remote] tr[data-source]').map((row) => ({
    source: row.dataset.source,
    subscribed: row.dataset.subscribed === 'true',
  }))`);
}

// Snapshot do painel de depuração (data-debug-json); o painel precisa estar aberto.
async function debugJson(app) {
  return app.cdp.eval(`debug()`);
}

function describeLayers(screen) {
  return (screen?.outbound?.layers ?? [])
    .map(
      (layer) =>
        `${layer.rid} ${layer.width}x${layer.height}@${layer.fps} ${layer.bitrateKbps}k ativa=${layer.active}`,
    )
    .join(' ; ');
}

// Dynacast: sem ninguém assistindo, o SFU manda o emissor pausar todas as camadas (active=false).
async function waitLayersPaused(app, timeout = 25_000) {
  let last = null;
  const paused = await waitFor(
    async () => {
      last = (await debugJson(app))?.voice?.screen ?? null;
      const layers = last?.outbound?.layers ?? [];
      return layers.length > 0 && layers.every((layer) => layer.active === false);
    },
    { timeout, interval: 500 },
  );
  return { paused: Boolean(paused), detail: describeLayers(last) || 'sem estatísticas' };
}

// Maior largura recebida da tela de A na seção do painel de B ("voice" ou "spectator").
async function waitScreenWidth(app, sectionKey, minWidth, timeout = 45_000) {
  let best = null;
  const reached = await waitFor(
    async () => {
      const row = (await debugJson(app))?.[sectionKey]?.remote.find(
        (item) => item.source === 'screen_share' && item.inbound,
      );
      const width = row?.inbound?.width ?? 0;
      if (row && (!best || width >= best.width)) {
        best = { width, label: `${width}x${row.inbound.height} @ ${row.inbound.fps} fps` };
      }
      return width >= minWidth;
    },
    { timeout, interval: 500 },
  );
  return { reached: Boolean(reached), best };
}

async function micSnapshot(app) {
  return (await debugJson(app))?.voice?.mic ?? null;
}

// Níveis do processador local e bitrate do microfone em `seconds` leituras do painel.
// maxGap = maior diferença entre entrada e saída do gate (perto de 0 quando nada corta o sinal);
// maxChannelGap = maior diferença entre o canal 0 e o downmix da saída (0 numa saída mono; 6 dB com canal vazio).
async function micLevels(app, seconds = 4) {
  const rows = [];
  for (let i = 0; i < seconds; i++) {
    await sleep(1_000);
    rows.push(await micSnapshot(app));
  }
  const numbers = (pick) => rows.map(pick).filter((value) => typeof value === 'number');
  const outputs = numbers((row) => row?.outputDb);
  const gapOf = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) : null);
  const round = (values) => (values.length > 0 ? Math.round(Math.max(...values) * 10) / 10 : null);
  const gaps = numbers((row) => gapOf(row?.inputDb, row?.outputDb));
  // Só leituras com sinal: no silêncio os dois medidores ficam no piso de -100.
  const channelGaps = numbers((row) =>
    (row?.outputDb ?? -100) > -90 ? gapOf(row?.outputDb, row?.firstChannelDb) : null,
  );
  const rates = numbers((row) => row?.outbound?.bitrateKbps);
  return {
    sendingProcessed: rows.every((row) => row?.sendingProcessed === true),
    maxOutput: outputs.length > 0 ? Math.max(...outputs) : null,
    maxGap: round(gaps),
    maxChannelGap: round(channelGaps),
    kbps:
      rates.length > 0
        ? Math.round((rates.reduce((s, v) => s + v, 0) / rates.length) * 10) / 10
        : null,
  };
}

// Média do bitrate do microfone publicado em `seconds` leituras do painel.
async function micBitrate(app, seconds = 5) {
  const values = [];
  for (let i = 0; i < seconds; i++) {
    await sleep(1_000);
    const rate = (await micSnapshot(app))?.outbound?.bitrateKbps;
    if (typeof rate === 'number') {
      values.push(rate);
    }
  }
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  section('Preparação');
  if (exePath) {
    mustPass('executável empacotado encontrado', existsSync(exePath), exePath);
  } else {
    if (!args.includes('--no-build')) {
      console.log('Compilando o app (npm run build)...');
      execSync('npm run build', { cwd: frontendDir, stdio: 'ignore' });
    }
    if (!existsSync(join(frontendDir, 'out', 'main', 'index.js'))) {
      throw new Error('out/ não encontrado: rode npm run build');
    }
  }
  stack = await startStack();
  check('servidor de teste isolado no ar (LiveKit + backend descartáveis)', true, stack.serverUrl);

  const suffix = Date.now().toString(36);
  const users = {
    A: { name: `e2e_a_${suffix}`, password: `senha-a-${suffix}` },
    B: { name: `e2e_b_${suffix}`, password: `senha-b-${suffix}` },
  };
  const invites = [stack.createInvite(), stack.createInvite()];
  check(
    'convites gerados pelo backend Go (server invite create)',
    invites.every((code) => code.length >= 8),
  );

  tempRoot = await mkdtemp(join(tmpdir(), 'livekit-e2e-'));
  const launch = async (name, port, extraArgs = []) => {
    const app = await launchApp({
      name,
      port,
      userDataDir: join(tempRoot, name),
      serverUrl: stack.serverUrl,
      exePath,
      extraArgs,
    });
    apps.push(app);
    return app;
  };
  // O microfone de A é um tom constante de -45 dBFS: permite conferir nível e noise gate de forma determinística.
  const tone = await writeToneWav(join(tempRoot, 'tom-45db.wav'), -45);
  const A = await launch('A', 9311, [`--use-file-for-fake-audio-capture=${tone}`]);
  const B = await launch('B', 9312);

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
  await screenshot(B, '04-presenca');

  section('5. Transmissão aparece AO VIVO');
  await A.cdp.eval(`click('button[title="Compartilhar a tela"]')`);
  const source = await waitFor(
    () => A.cdp.eval(`$('[data-source-id^="screen:"]')?.dataset.sourceId ?? null`),
    { timeout: 15_000 },
  );
  check('A: seletor listou uma tela', Boolean(source), String(source));
  check(
    'A: codec padrão é o automático',
    (await A.cdp.eval(`$('[data-screen-codec]')?.value`)) === 'auto',
  );
  const preview = await waitFor(
    () =>
      A.cdp.eval(
        `text('[data-codec-preview]')?.startsWith('Será usado') ? text('[data-codec-preview]') : null`,
      ),
    { timeout: 10_000 },
  );
  check('A: seletor mostra o que o automático vai usar', Boolean(preview), String(preview));
  // Com áudio do sistema, para conferir que o áudio do stream sai sem processamento de voz.
  await A.cdp.eval(
    `(() => { const box = $('[data-include-audio]'); if (box && !box.checked) box.click(); return true; })()`,
  );
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

  section('5b. Emissor sem espectador e configuração da tela');
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  const idle = await waitLayersPaused(A);
  check('ninguém assistindo: dynacast pausou todas as camadas de A', idle.paused, idle.detail);
  const shared = (await debugJson(A))?.voice?.screen ?? null;
  check(
    'A: degradationPreference = maintain-resolution',
    shared?.outbound?.degradationPreference === 'maintain-resolution',
    String(shared?.outbound?.degradationPreference),
  );
  check(
    'A: codec escolhido pelo automático',
    Boolean(shared?.activeCodec) && /automático|hardware|software/.test(shared?.decision ?? ''),
    `${shared?.activeCodec}: ${shared?.decision}`,
  );
  const screenAudio = (await debugJson(A))?.voice?.screenAudio ?? null;
  if (!screenAudio) {
    note('áudio da tela sem processamento', 'a captura não trouxe áudio do sistema neste ambiente');
  } else {
    const processing = screenAudio.processing;
    check(
      'áudio da tela sem eco, ruído nem ganho (música/jogo)',
      processing.echoCancellation === false &&
        processing.noiseSuppression === false &&
        processing.autoGainControl === false &&
        screenAudio.processor === null,
      JSON.stringify({ ...processing, processor: screenAudio.processor }),
    );
  }
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);

  section('6. Modo Espectador assina só a tela');
  await B.cdp.eval(`click('[data-channel-id="${CHANNEL_ID}"]')`);
  check(
    'B (fora da voz) vê a transmissão com botão Assistir',
    await waitFor(() => B.cdp.eval(`exists('[data-live-list] [data-watch-identity]')`)),
  );
  await B.cdp.eval(`click('[data-live-list] [data-watch-identity]')`);
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
    'Espectador assinou só a tela (vídeo e, se houver, o áudio dela)',
    subscribed.includes('screen_share') &&
      subscribed.every((item) => item === 'screen_share' || item === 'screen_share_audio'),
    `assinadas: ${subscribed.join(', ') || 'nenhuma'}`,
  );
  if (spectatorRows.some((row) => row.source === 'screen_share_audio')) {
    check(
      'áudio da transmissão já vem ligado ao assistir',
      await waitFor(async () =>
        (await debugRows(B, 'Espectador')).some(
          (row) => row.source === 'screen_share_audio' && row.subscribed,
        ),
      ),
    );
  }
  check(
    'Espectador não assinou o microfone de A',
    spectatorRows.some((row) => row.source === 'microphone' && !row.subscribed),
    JSON.stringify(spectatorRows),
  );
  // O simulcast começa na camada baixa e sobe conforme a estimativa de banda; o espectador pede a HIGH.
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  let best = null;
  const full = await waitFor(
    async () => {
      const snapshot = await debugJson(B);
      const row = snapshot?.spectator?.remote.find(
        (item) => item.source === 'screen_share' && item.inbound,
      );
      const width = row?.inbound?.width ?? 0;
      if (row && (!best || width >= best.width)) {
        best = { width, label: `${width}x${row.inbound.height} @ ${row.inbound.fps} fps` };
      }
      return width >= 1920;
    },
    { timeout: 45_000, interval: 500 },
  );
  check(
    'B recebe a camada alta da tela (≥ 1280 px de largura)',
    (best?.width ?? 0) >= 1280,
    best?.label ?? 'sem estatísticas',
  );
  check('B recebe a tela em 1080p (camada f)', Boolean(full), best?.label ?? 'sem estatísticas');
  const sent = await waitFor(async () => {
    const screen = (await debugJson(A))?.voice?.screen;
    const layers = screen?.outbound?.layers ?? [];
    return layers.length > 0 && layers.some((layer) => layer.bitrateKbps !== null) ? screen : null;
  });
  check(
    'A: captura e camadas publicadas',
    Boolean(sent),
    sent
      ? `fonte ${sent.outbound.sourceFps} fps | ${sent.outbound.layers
          .map(
            (layer) =>
              `${layer.rid} ${layer.width}x${layer.height}@${layer.fps} ${layer.bitrateKbps}k ${layer.encoder} (${layer.powerEfficient ? 'hw' : 'sw'}, ${layer.limitation})`,
          )
          .join(' ; ')}`
      : 'sem estatísticas',
  );
  // Se o automático previu GPU, a estatística real tem de confirmar (a escolha seguinte usa a medição).
  const live = (await debugJson(A))?.voice?.screen ?? null;
  const top = live?.outbound?.layers.find((layer) => layer.active !== false && layer.encoder);
  if (live?.decision?.includes('por hardware')) {
    check(
      'A: codificador por hardware em uso, como o automático previu',
      top?.powerEfficient === true,
      `${live.activeCodec}: ${top?.encoder} (${live.decision})`,
    );
  } else {
    note('codificador por hardware', `automático escolheu software: ${live?.decision}`);
  }
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
  check(
    'B segue assistindo, agora pela conexão de voz',
    await waitFor(() => B.cdp.eval(`exists('[data-watch-mode="voice"]')`)),
  );
  const viaVoice = await waitScreenWidth(B, 'voice', 1920);
  check(
    'pela voz B recebe a camada máxima (1920 px, sem adaptiveStream)',
    viaVoice.reached,
    viaVoice.best?.label ?? 'sem estatísticas',
  );

  section('7b. Na voz, a tela só é assinada ao clicar em Assistir');
  await B.cdp.eval(`clickText('button', 'Parar de assistir')`);
  check(
    'B na grade vê o cartão AO VIVO com botão Assistir, sem vídeo da tela',
    await waitFor(() =>
      B.cdp.eval(
        `exists('[data-tile="screen"] [data-watch-identity]') && !exists('[data-tile="screen"] video')`,
      ),
    ),
  );
  const unsubscribed = await waitFor(async () => {
    const rows = await debugRows(B, 'Voz');
    return rows.some((row) => row.source === 'screen_share') &&
      rows.every((row) => !row.source.startsWith('screen_share') || !row.subscribed)
      ? rows
      : null;
  });
  check(
    '"Parar de assistir" cancelou a assinatura da tela (e do áudio dela)',
    Boolean(unsubscribed),
    JSON.stringify(unsubscribed || (await debugRows(B, 'Voz'))),
  );
  check(
    'microfone de A continua assinado na voz',
    (await debugRows(B, 'Voz')).some((row) => row.source === 'microphone' && row.subscribed),
  );
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
  const pausedAgain = await waitLayersPaused(A);
  check(
    'B na voz sem assistir: dynacast pausou as camadas de A',
    pausedAgain.paused,
    pausedAgain.detail,
  );
  await B.cdp.eval(`click('[data-tile="screen"] [data-watch-identity]')`);
  check(
    'Assistir pela grade abre a tela grande na conexão de voz',
    await waitFor(() => B.cdp.eval(`exists('[data-watch-mode="voice"]')`)),
  );
  const again = await waitScreenWidth(B, 'voice', 1920);
  check('Assistir de novo recebe 1920 px', again.reached, again.best?.label ?? 'sem estatísticas');
  await B.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);

  section('7c. Áudio da voz');
  const mic = await waitFor(async () => {
    const snapshot = await micSnapshot(A);
    return snapshot?.outbound?.maxBitrateKbps ? snapshot : null;
  });
  check(
    'microfone: eco, ruído e ganho nativos ligados (modo Padrão)',
    mic?.processing.echoCancellation === true &&
      mic?.processing.noiseSuppression === true &&
      mic?.processing.autoGainControl === true &&
      mic?.processor === null,
    JSON.stringify(mic?.processing),
  );
  check(
    'microfone: Opus com teto de 64 kbps',
    mic?.outbound?.maxBitrateKbps === 64,
    `${mic?.outbound?.maxBitrateKbps} kbps · ${mic?.outbound?.codec}`,
  );
  check(
    'microfone: RED ativo (redundância contra perda, primeiro codec negociado)',
    mic?.outbound?.redActive === true,
    `negociados ${mic?.outbound?.negotiated?.join(', ')}`,
  );
  await A.cdp.eval(`click('button[title="Configurações"]')`);
  await waitFor(() => A.cdp.eval(`click('[data-settings-tab="audio"]')`));
  await waitFor(() => A.cdp.eval(`exists('[data-audio-settings]')`));

  await A.cdp.eval(`click('[data-suppression="off"]')`);
  const off = await waitFor(
    async () => {
      const snapshot = await micSnapshot(A);
      return snapshot?.processor === null && snapshot.processing.noiseSuppression === false
        ? snapshot
        : null;
    },
    { timeout: 15_000 },
  );
  check(
    'modo Desligada: captura reiniciada sem supressão nativa (eco e ganho seguem ligados)',
    Boolean(off) &&
      off.processing.echoCancellation === true &&
      off.processing.autoGainControl === true,
    JSON.stringify((await micSnapshot(A))?.processing),
  );

  await A.cdp.eval(`click('[data-mic-test]')`);
  // A fonte falsa alterna bipes curtos e silêncio digital (-100 dBFS): espera até o medidor pegar um bipe.
  let loudest = null;
  const heard = await waitFor(
    async () => {
      const value = await A.cdp.eval(
        `(() => { const v = $('[data-mic-level]')?.dataset.micLevel; return v ? Number(v) : null; })()`,
      );
      if (typeof value === 'number' && (loudest === null || value > loudest)) {
        loudest = value;
      }
      return typeof value === 'number' && value > -90;
    },
    { timeout: 15_000, interval: 50 },
  );
  check(
    '"Testar microfone" toca a voz processada e mede o nível',
    Boolean(heard),
    `nível ${loudest?.toFixed(1)} dBFS`,
  );
  await A.cdp.eval(`click('[data-mic-test]')`);

  await A.cdp.eval(`click('[data-suppression="advanced"]')`);
  const advanced = await waitFor(
    async () => {
      const snapshot = await micSnapshot(A);
      return snapshot?.processor === 'rnnoise' && snapshot.processing.noiseSuppression === false
        ? snapshot
        : null;
    },
    { timeout: 15_000 },
  );
  const voiceError = await A.cdp.eval(`text('[data-voice-error]')`);
  check(
    'modo Avançado: RNNoise carregado (WASM + worklet) e supressão nativa desligada',
    Boolean(advanced) && !voiceError,
    voiceError || JSON.stringify((await micSnapshot(A))?.processing),
  );

  // Canais: o RNNoise processa um canal só; se a saída dele tiver um segundo canal vazio, o downmix para mono do
  // envio derruba a voz em 6 dB (defeito já visto). Numa saída mono, canal 0 e downmix têm o mesmo nível.
  const rnnoiseLevels = await micLevels(A, 3);
  check(
    'RNNoise: o WebRTC envia a trilha processada, mono, sem perder nível',
    rnnoiseLevels.sendingProcessed &&
      rnnoiseLevels.maxChannelGap !== null &&
      rnnoiseLevels.maxChannelGap < 1,
    JSON.stringify(rnnoiseLevels),
  );

  // Gate testado sem RNNoise: o tom constante é ruído estacionário para o RNNoise, que passa a suprimi-lo em
  // alguns segundos (correto, mas o nível deixaria de ser previsível). No modo Desligada o tom chega estável.
  // Limite -10 dB: bem acima do tom, o gate tem de ficar fechado; limite -80 dB: aberto, sem perda de nível.
  await A.cdp.eval(`click('[data-suppression="off"]')`);
  await waitFor(async () => (await micSnapshot(A))?.processor === null, { timeout: 15_000 });
  await A.cdp.eval(
    `(() => { const box = $('[data-gate-enabled]'); if (!box.checked) box.click(); return true; })()`,
  );
  await A.cdp.eval(`fill('[data-gate-threshold]', '-10')`);
  const gated = await waitFor(async () => (await micSnapshot(A))?.processor === 'gate -10 dB', {
    timeout: 15_000,
  });
  check(
    'gate ligado no microfone publicado (-10 dB)',
    Boolean(gated),
    (await micSnapshot(A))?.processor,
  );
  // Retenção (200 ms) + rampa de saída antes de medir.
  await sleep(1_500);
  const gateClosed = await micLevels(A);
  check(
    'gate fechado: saída em silêncio e o microfone quase sem banda (DTX)',
    gateClosed.maxOutput !== null &&
      gateClosed.maxOutput <= -95 &&
      gateClosed.kbps !== null &&
      gateClosed.kbps < 6,
    JSON.stringify(gateClosed),
  );
  await A.cdp.eval(`fill('[data-gate-threshold]', '-80')`);
  await waitFor(async () => (await micSnapshot(A))?.processor === 'gate -80 dB', {
    timeout: 10_000,
  });
  await sleep(500);
  const gateOpen = await micLevels(A);
  check(
    'gate aberto (limite ajustado ao vivo): a voz passa inteira',
    gateOpen.maxGap !== null &&
      gateOpen.maxGap < 1 &&
      (gateOpen.maxChannelGap ?? 99) < 1 &&
      (gateOpen.maxOutput ?? -100) > -70,
    JSON.stringify(gateOpen),
  );

  await A.cdp.eval(`click('[data-suppression="standard"]')`);
  await A.cdp.eval(
    `(() => { const box = $('[data-gate-enabled]'); if (box.checked) box.click(); return true; })()`,
  );
  const restored = await waitFor(
    async () => {
      const snapshot = await micSnapshot(A);
      return snapshot?.processor === null && snapshot.processing.noiseSuppression === true;
    },
    { timeout: 15_000 },
  );
  check('volta ao Padrão: sem processador e com a supressão nativa', Boolean(restored));
  await A.cdp.eval(`key('Escape')`);

  // DTX: com o microfone mudo o WebRTC codifica silêncio digital; com DTX o Opus quase não manda pacotes.
  const speakingRate = await micBitrate(A);
  await A.cdp.eval(`click('button[title="Mutar microfone"]')`);
  await sleep(2_000);
  const mutedRate = await micBitrate(A);
  await A.cdp.eval(`click('button[title="Ativar microfone"]')`);
  check(
    'DTX: microfone mudo quase não gasta banda',
    mutedRate !== null && mutedRate < 1,
    `falando ${speakingRate?.toFixed(1)} kbps -> mudo ${mutedRate?.toFixed(2)} kbps`,
  );
  await A.cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);

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
  await stack.restartBackend();
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
  const reconnects = stack
    .backendLogsSince(restartedAt)
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
      stack
        .backendLogsSince(logoutAt)
        .split('\n')
        .some((line) => line.includes('websocket desconectado') && line.includes(session.user.id)),
    { timeout: 10_000, interval: 500 },
  );
  check('backend registrou o WebSocket de A fechado', Boolean(closed));
  await sleep(3000);
  const reopened = stack
    .backendLogsSince(logoutAt)
    .split('\n')
    .some((line) => line.includes('websocket conectado') && line.includes(session.user.id));
  check('A não reconecta depois de sair', !reopened);
}

async function cleanup() {
  for (const app of apps) {
    killApp(app);
  }
  stack?.stop();
  if (tempRoot) {
    await sleep(500);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

cleanupOnSignal(cleanup);
let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err;
  console.error(
    `\n\x1b[31mInterrompido: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
  );
} finally {
  await cleanup();
}

const failures = reporter.summary();
if (screenshotsDir) {
  console.log(`Capturas em ${screenshotsDir}`);
}
if (failures > 0 || fatal) {
  for (const app of apps) {
    const errors = errorLines(app);
    if (errors.length > 0) {
      console.log(`\nLog de ${app.name} (linhas com erro):\n  ${errors.join('\n  ')}`);
    }
  }
}
process.exit(failures === 0 && !fatal ? 0 : 1);
