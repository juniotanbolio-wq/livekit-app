// Medição de qualidade da tela (Fase Q, docs/medicoes.md): duas instâncias do app no servidor descartável de
// scripts/lib/stack.mjs, com a fonte falsa do Chromium a 60 fps. A transmite, B assiste de quatro jeitos:
//
//   1. sem espectador     B fora do canal: o dynacast deve pausar as camadas de A (upload perto de zero)
//   2. espectador         B no Modo Espectador (segunda conexão, só a tela)
//   3. voz (sem clicar)   B na voz do canal olhando a grade (sem clicar em Assistir)
//   4. voz (assistindo)   B na voz e assistindo em tela grande
//
//   npm run medir                                (compila antes; --no-build pula)
//   npm run medir -- --codecs h264,av1           (codecs da tela; "auto" = escolha automática)
//   npm run medir -- --no-hw-flags               (A sem as flags de codificação por hardware)
//   npm run medir -- --exe <caminho do .exe>     (app empacotado)
//
// Cada cenário espera a transmissão estabilizar e tira a média de 10 leituras (1 por segundo) do painel de
// depuração. O resultado sai em tabela markdown e em JSON (caminho impresso no fim).
import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { frontendDir, killApp, launchApp } from './lib/apps.mjs';
import { createReporter, sleep, waitFor } from './lib/harness.mjs';
import { cleanupOnSignal, startStack } from './lib/stack.mjs';

const CHANNEL_ID = 'voice-1';
const SETTLE_MS = 15_000;
const SAMPLES = 10;
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}
const codecs = (argValue('--codecs') ?? 'h264,av1').split(',').map((item) => item.trim());
const exePath = argValue('--exe') ? resolve(argValue('--exe')) : null;
const noHwFlags = args.includes('--no-hw-flags');

const reporter = createReporter();
const { mustPass, section } = reporter;
let stack = null;
let tempRoot = null;
const apps = [];

// ---------- agregação ----------
function mean(values) {
  const numbers = values.filter((value) => typeof value === 'number');
  return numbers.length === 0
    ? null
    : Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10;
}

function last(values) {
  return [...values].reverse().find((value) => value !== null && value !== undefined) ?? null;
}

function cpuOf(system, type) {
  return system
    ? system.processes.filter((item) => item.type === type).reduce((s, i) => s + i.cpuPercent, 0)
    : null;
}

function summarizeSender(samples) {
  const screens = samples.map((sample) => sample?.voice?.screen?.outbound ?? null);
  const rids = [
    ...new Set(screens.flatMap((screen) => screen?.layers.map((layer) => layer.rid) ?? [])),
  ];
  const layers = rids.map((rid) => {
    const series = screens.map(
      (screen) => screen?.layers.find((layer) => layer.rid === rid) ?? null,
    );
    const pick = (field) => series.map((layer) => (layer ? layer[field] : null));
    return {
      rid,
      width: last(pick('width')),
      height: last(pick('height')),
      fps: mean(pick('fps')),
      kbps: mean(pick('bitrateKbps')),
      active: last(pick('active')),
      encoder: last(pick('encoder')),
      powerEfficient: last(pick('powerEfficient')),
      limitation: last(pick('limitation')),
      msPerFrame: mean(pick('msPerFrame')),
      codec: last(pick('codec')),
    };
  });
  return {
    layers,
    sourceFps: mean(screens.map((screen) => screen?.sourceFps ?? null)),
    totalKbps: mean(screens.map((screen) => screen?.totalKbps ?? null)),
    availableKbps: mean(screens.map((screen) => screen?.availableOutgoingKbps ?? null)),
    degradation: last(screens.map((screen) => screen?.degradationPreference ?? null)),
    cpuTab: mean(samples.map((sample) => cpuOf(sample?.system, 'Tab'))),
    cpuGpu: mean(samples.map((sample) => cpuOf(sample?.system, 'GPU'))),
  };
}

function summarizeReceiver(samples, sectionKey) {
  const rows = samples.map(
    (sample) =>
      sample?.[sectionKey]?.remote.find((row) => row.source === 'screen_share' && row.inbound)
        ?.inbound ?? null,
  );
  const subscribed = samples.map(
    (sample) =>
      sample?.[sectionKey]?.remote.find((row) => row.source === 'screen_share')?.subscribed ?? null,
  );
  const pick = (field) => rows.map((row) => (row ? row[field] : null));
  return {
    subscribed: last(subscribed),
    width: last(pick('width')),
    height: last(pick('height')),
    fps: mean(pick('fps')),
    kbps: mean(pick('bitrateKbps')),
    codec: last(pick('codec')),
    decoder: last(pick('decoder')),
    packetsLost: last(pick('packetsLost')),
    framesDropped: last(pick('framesDropped')),
    freezeCount: last(pick('freezeCount')),
    jitterMs: mean(pick('jitterMs')),
  };
}

async function sample(app) {
  return app.cdp.eval(`debug()`).catch(() => null);
}

async function measure(A, B, receiverSection) {
  await sleep(SETTLE_MS);
  const senderSamples = [];
  const receiverSamples = [];
  for (let i = 0; i < SAMPLES; i++) {
    senderSamples.push(await sample(A));
    receiverSamples.push(await sample(B));
    await sleep(1_000);
  }
  return {
    sender: summarizeSender(senderSamples),
    receiver: receiverSection ? summarizeReceiver(receiverSamples, receiverSection) : null,
  };
}

// ---------- passos na interface ----------
async function setupAndRegister(app, invite, user) {
  const { cdp } = app;
  await waitFor(() => cdp.eval(`exists('[data-screen="server-setup"]')`));
  await cdp.eval(
    `fill('#serverUrl', ${JSON.stringify(stack.serverUrl)}) && submit('[data-server-form]')`,
  );
  await waitFor(() => cdp.eval(`exists('[data-screen="auth"]')`));
  await cdp.eval(`clickText('[data-screen="auth"] button', 'Cadastre-se')`);
  await waitFor(() => cdp.eval(`exists('#inviteCode')`));
  await cdp.eval(
    `fill('#inviteCode', ${JSON.stringify(invite)}) && fill('#username', ${JSON.stringify(user.name)}) && fill('#password', ${JSON.stringify(user.password)}) && fill('#confirm', ${JSON.stringify(user.password)}) && submit('[data-screen="auth"] form')`,
  );
  mustPass(
    `${app.name} cadastrado e conectado`,
    await waitFor(() => cdp.eval(`exists('[data-realtime-status="connected"]')`), {
      timeout: 20_000,
    }),
  );
  await cdp.eval(`key('D', { ctrlKey: true, shiftKey: true })`);
}

async function startShare(A, codec) {
  await A.cdp.eval(`click('button[title="Compartilhar a tela"]')`);
  await waitFor(() => A.cdp.eval(`exists('[data-source-id^="screen:"]')`), { timeout: 15_000 });
  const chosen = await A.cdp.eval(`choose('[data-screen-codec]', ${JSON.stringify(codec)})`);
  mustPass(`A: codec ${codec} escolhido no seletor`, chosen);
  await A.cdp.eval(
    `click('[data-source-id^="screen:"]') && clickText('[role="dialog"] button', 'Compartilhar')`,
  );
  mustPass(
    `A: tela publicada (${codec})`,
    await waitFor(() => A.cdp.eval(`exists('button[title="Parar de compartilhar a tela"]')`), {
      timeout: 20_000,
    }),
  );
}

async function stopShare(A) {
  await A.cdp.eval(`click('button[title="Parar de compartilhar a tela"]')`);
  await waitFor(() => A.cdp.eval(`exists('button[title="Compartilhar a tela"]')`), {
    timeout: 10_000,
  });
}

// Funciona com a interface antiga (tile clicável, botão "Assistir transmissão") e com a da Fase Q
// (botões "Assistir" com data-watch-identity).
async function watchAsSpectator(B) {
  await B.cdp.eval(`click('[data-channel-id="${CHANNEL_ID}"]')`);
  const clicked = await waitFor(() =>
    B.cdp.eval(`click('[data-watch-identity]') || clickText('button', 'Assistir transmissão')`),
  );
  mustPass(
    'B: assistindo pelo Modo Espectador',
    clicked && (await waitFor(() => B.cdp.eval(`exists('[data-watch-mode="spectator"]')`))),
  );
}

async function joinVoiceGrid(B) {
  await B.cdp.eval(`click('button[title="Entrar na voz deste canal"]')`);
  mustPass(
    'B: entrou na voz',
    await waitFor(
      () => B.cdp.eval(`exists('[data-debug-section="Voz"] [data-debug-state="connected"]')`),
      {
        timeout: 20_000,
      },
    ),
  );
  // Volta para a grade do canal (sem assistir em tela grande).
  await B.cdp.eval(`clickText('button', 'Parar de assistir')`);
  mustPass('B: na grade da voz', await waitFor(() => B.cdp.eval(`exists('[data-tile="screen"]')`)));
}

async function watchFromVoice(B) {
  const clicked = await B.cdp.eval(
    `click('[data-tile="screen"] [data-watch-identity]') || click('button[data-tile="screen"]')`,
  );
  mustPass(
    'B: assistindo pela voz',
    clicked && (await waitFor(() => B.cdp.eval(`exists('[data-watch-mode="voice"]')`))),
  );
}

async function resetViewer(B) {
  await B.cdp.eval(`clickText('button', 'Parar de assistir')`);
  await B.cdp.eval(`click('button[title="Sair do canal de voz"]')`);
  await waitFor(
    () => B.cdp.eval(`exists('[data-debug-section="Voz"] [data-debug-state="disconnected"]')`),
    {
      timeout: 10_000,
    },
  );
}

// ---------- tabela ----------
function fmt(value, suffix = '') {
  return value === null || value === undefined ? '-' : `${value}${suffix}`;
}

function layerText(layer) {
  const state = layer.active === false ? ' (pausada)' : '';
  return `${layer.rid} ${fmt(layer.width)}x${fmt(layer.height)}@${fmt(layer.fps)} ${fmt(layer.kbps)}k${state}`;
}

function toMarkdown(rows, system) {
  const lines = [];
  if (system) {
    const gpu = system.gpus.find((item) => item.active) ?? system.gpus[0];
    lines.push(
      `Electron ${system.electron} (Chromium ${system.chrome}) · GPU ${gpu?.name ?? '-'} · video_encode ${system.gpuFeatures['video_encode'] ?? '-'} · features: ${system.enabledFeatures.join(', ') || 'nenhuma'}`,
      '',
    );
  }
  lines.push(
    '| Cenário | Codec | Codificador (A) | HW | Camadas enviadas | Fonte | Upload A | Limitação | ms/q (maior) | CPU A página/GPU (% da máquina) | Recebido em B | Perdas/desc./cong. | Jitter |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const row of rows) {
    const { sender, receiver } = row.result;
    const top = sender.layers[0];
    const received = receiver
      ? receiver.subscribed
        ? `${fmt(receiver.width)}x${fmt(receiver.height)}@${fmt(receiver.fps)} ${fmt(receiver.kbps)}k`
        : 'não assinada'
      : '-';
    lines.push(
      `| ${row.scenario} | ${row.codec} | ${top?.encoder ?? '-'} | ${top ? (top.powerEfficient ? 'sim' : 'não') : '-'} | ${sender.layers.map(layerText).join('; ') || '-'} | ${fmt(sender.sourceFps)} fps | ${fmt(sender.totalKbps)} kbps | ${top?.limitation ?? '-'} | ${fmt(top?.msPerFrame)} | ${fmt(sender.cpuTab)}/${fmt(sender.cpuGpu)} | ${received} | ${receiver ? `${fmt(receiver.packetsLost)}/${fmt(receiver.framesDropped)}/${fmt(receiver.freezeCount)}` : '-'} | ${receiver ? fmt(receiver.jitterMs, ' ms') : '-'} |`,
    );
  }
  return lines.join('\n');
}

// ---------- principal ----------
async function main() {
  section('Preparação');
  if (!exePath && !args.includes('--no-build')) {
    console.log('Compilando o app (npm run build)...');
    execSync('npm run build', { cwd: frontendDir, stdio: 'ignore' });
  }
  stack = await startStack();
  tempRoot = await mkdtemp(join(tmpdir(), 'livekit-medir-'));
  const suffix = Date.now().toString(36);
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
  const A = await launch('A', 9321, noHwFlags ? ['--no-hw-encode-flags'] : []);
  const B = await launch('B', 9322);
  await setupAndRegister(A, stack.createInvite(), {
    name: `med_a_${suffix}`,
    password: `senha-a-${suffix}`,
  });
  await setupAndRegister(B, stack.createInvite(), {
    name: `med_b_${suffix}`,
    password: `senha-b-${suffix}`,
  });

  await A.cdp.eval(`click('[data-channel-id="${CHANNEL_ID}"]')`);
  mustPass(
    'A na voz do canal',
    await waitFor(
      () => A.cdp.eval(`exists('[data-debug-section="Voz"] [data-debug-state="connected"]')`),
      {
        timeout: 20_000,
      },
    ),
  );

  const rows = [];
  for (const codec of codecs) {
    section(`Codec ${codec}`);
    await startShare(A, codec);

    console.log('  1. sem espectador');
    rows.push({ codec, scenario: 'sem espectador', result: await measure(A, B, null) });

    console.log('  2. espectador');
    await watchAsSpectator(B);
    rows.push({ codec, scenario: 'espectador', result: await measure(A, B, 'spectator') });

    console.log('  3. voz (sem clicar)');
    await joinVoiceGrid(B);
    rows.push({ codec, scenario: 'voz (sem clicar)', result: await measure(A, B, 'voice') });

    console.log('  4. voz (assistindo)');
    await watchFromVoice(B);
    rows.push({ codec, scenario: 'voz (assistindo)', result: await measure(A, B, 'voice') });

    await resetViewer(B);
    await stopShare(A);
  }

  const system = (await sample(A))?.system ?? null;
  const markdown = toMarkdown(rows, system);
  const jsonPath = join(
    tmpdir(),
    `livekit-medicoes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(jsonPath, JSON.stringify({ system, noHwFlags, rows }, null, 2), 'utf8');
  section('Resultado');
  console.log(markdown);
  console.log(`\nJSON: ${jsonPath}`);
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
process.exit(fatal || reporter.failed().length > 0 ? 1 : 0);
