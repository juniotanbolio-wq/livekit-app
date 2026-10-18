// Servidor descartável para o aceite e a medição do frontend: LiveKit + backend em contêineres, rede e volume
// próprios, segredos gerados nesta execução e portas que não colidem com o Compose de desenvolvimento
// (7880-7882 e 8080) nem com o aceite do backend (17880/18080). Nada do ambiente de dev é tocado: nem o banco,
// nem o infra/.env, nem o limite de login do backend de dev (achado T1 da auditoria).
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sleep, waitFor } from './harness.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Etiqueta de tudo que o stack cria: permite apagar sobras de uma execução interrompida sem risco de tocar em
// contêineres de outra coisa.
const LABEL = 'livekit-app.test=frontend';
// A porta de mídia anunciada pelo LiveKit (node_ip 127.0.0.1) precisa ser a mesma do lado de fora do contêiner:
// por isso TCP e UDP usam a mesma porta dentro e fora. A sinalização pode ser remapeada.
const PORTS = { signal: 27880, tcp: 27881, udp: 27882, api: 28080 };
const BACKEND_IMAGE = 'livekit-backend:e2e';
const LIVEKIT_KEY = 'e2ekey';

function docker(args, { allowFail = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`docker não encontrado ou não iniciou: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    throw new Error(`docker ${args[0]} falhou: ${(result.stderr || result.stdout).trim()}`);
  }
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

// Segredo de uso único do gerador criptográfico. Validado antes de usar (tamanho, alfabeto, variedade) e nunca
// impresso: vai para os contêineres por arquivo de ambiente temporário, não pela linha de comando.
export function newSecret() {
  const value = randomBytes(24).toString('hex');
  if (!/^[0-9a-f]{48}$/.test(value) || new Set(value).size < 8 || /^0+$/.test(value)) {
    throw new Error('gerador de segredos devolveu valor inválido');
  }
  return value;
}

function removeLeftovers() {
  const filter = ['--filter', `label=${LABEL}`];
  const containers = docker(['ps', '-aq', ...filter])
    .out.split(/\s+/)
    .filter(Boolean);
  if (containers.length > 0) {
    docker(['rm', '-f', ...containers], { allowFail: true });
  }
  const networks = docker(['network', 'ls', '-q', ...filter])
    .out.split(/\s+/)
    .filter(Boolean);
  for (const network of networks) {
    docker(['network', 'rm', network], { allowFail: true });
  }
  const volumes = docker(['volume', 'ls', '-q', ...filter])
    .out.split(/\s+/)
    .filter(Boolean);
  for (const volume of volumes) {
    docker(['volume', 'rm', '-f', volume], { allowFail: true });
  }
}

function liveKitImage() {
  const compose = readFileSync(join(repoRoot, 'infra', 'docker-compose.yml'), 'utf8');
  const match = /image:\s*(livekit\/livekit-server:\S+)/.exec(compose);
  if (!match) {
    throw new Error('imagem do LiveKit não encontrada em infra/docker-compose.yml');
  }
  return match[1];
}

// Copia o livekit.yaml do repositório (mesmas regras de sala) trocando só portas, chave e destino do webhook.
function liveKitConfig(apiName) {
  const original = readFileSync(join(repoRoot, 'infra', 'livekit.yaml'), 'utf8');
  const replacements = [
    ['tcp_port: 7881', `tcp_port: ${PORTS.tcp}`],
    ['udp_port: 7882', `udp_port: ${PORTS.udp}`],
    ['api_key: devkey', `api_key: ${LIVEKIT_KEY}`],
    ['http://backend:8080/webhooks/livekit', `http://${apiName}:8080/webhooks/livekit`],
  ];
  let yaml = original;
  for (const [from, to] of replacements) {
    if (!yaml.includes(from)) {
      throw new Error(
        `infra/livekit.yaml mudou (não achei "${from}"): ajuste scripts/lib/stack.mjs`,
      );
    }
    yaml = yaml.replace(from, to);
  }
  return yaml;
}

function envFile(path, values) {
  writeFileSync(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startStack({ log = (line) => console.log(line) } = {}) {
  docker(['info', '--format', '{{.ServerVersion}}']);
  removeLeftovers();

  const suffix = randomBytes(3).toString('hex');
  const names = {
    lk: `livekit-fe-e2e-lk-${suffix}`,
    api: `livekit-fe-e2e-api-${suffix}`,
    net: `livekit-fe-e2e-net-${suffix}`,
    volume: `livekit-fe-e2e-data-${suffix}`,
  };
  const tempDir = mkdtempSync(join(tmpdir(), 'livekit-fe-e2e-'));
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    docker(['rm', '-f', names.api, names.lk], { allowFail: true });
    docker(['network', 'rm', names.net], { allowFail: true });
    docker(['volume', 'rm', '-f', names.volume], { allowFail: true });
    rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    log('Compilando a imagem do backend (docker build)...');
    docker(['build', '-q', '-t', BACKEND_IMAGE, join(repoRoot, 'backend')]);

    const liveKitSecret = newSecret();
    const configPath = join(tempDir, 'livekit.yaml');
    writeFileSync(configPath, liveKitConfig(names.api), 'utf8');
    envFile(join(tempDir, 'livekit.env'), { LIVEKIT_KEYS: `${LIVEKIT_KEY}: ${liveKitSecret}` });
    envFile(join(tempDir, 'backend.env'), {
      JWT_SECRET: newSecret(),
      LIVEKIT_API_KEY: LIVEKIT_KEY,
      LIVEKIT_API_SECRET: liveKitSecret,
      LIVEKIT_PUBLIC_URL: `ws://localhost:${PORTS.signal}`,
      LIVEKIT_URL: `http://${names.lk}:7880`,
      // O app compilado tem origem app://desktop; nenhuma outra origem é aceita.
      CORS_ORIGINS: 'app://desktop',
      // O aceite faz vários cadastros e logins em sequência: o limite de produção (10 por 15 min) atrapalharia.
      AUTH_RATE_LIMIT: '1000',
      SEED_ADMIN_USERNAME: 'admin',
      SEED_ADMIN_PASSWORD: `admin-${newSecret().slice(0, 16)}`,
    });

    docker(['network', 'create', '--label', LABEL, names.net]);
    docker(['volume', 'create', '--label', LABEL, names.volume]);
    docker([
      'run',
      '-d',
      '--name',
      names.lk,
      '--label',
      LABEL,
      '--network',
      names.net,
      '-p',
      `127.0.0.1:${PORTS.signal}:7880`,
      '-p',
      `127.0.0.1:${PORTS.tcp}:${PORTS.tcp}`,
      '-p',
      `127.0.0.1:${PORTS.udp}:${PORTS.udp}/udp`,
      '--env-file',
      join(tempDir, 'livekit.env'),
      '-v',
      `${configPath}:/etc/livekit.yaml:ro`,
      liveKitImage(),
      '--config',
      '/etc/livekit.yaml',
      '--node-ip',
      '127.0.0.1',
    ]);
    docker([
      'run',
      '-d',
      '--name',
      names.api,
      '--label',
      LABEL,
      '--network',
      names.net,
      '-p',
      `127.0.0.1:${PORTS.api}:8080`,
      '-v',
      `${names.volume}:/data`,
      '--env-file',
      join(tempDir, 'backend.env'),
      BACKEND_IMAGE,
    ]);

    const liveKitUp = await waitFor(() => httpOk(`http://127.0.0.1:${PORTS.signal}/`), {
      timeout: 30_000,
      interval: 500,
    });
    if (!liveKitUp) {
      throw new Error('o LiveKit de teste não respondeu em 30 s');
    }
    const apiUp = await waitFor(() => httpOk(`http://127.0.0.1:${PORTS.api}/health`), {
      timeout: 30_000,
      interval: 500,
    });
    if (!apiUp) {
      throw new Error(`o backend de teste não respondeu em 30 s:\n${logsOf(names.api)}`);
    }
    docker(['exec', names.api, '/server', 'seed']);
  } catch (err) {
    stop();
    throw err;
  }

  return {
    serverUrl: `http://localhost:${PORTS.api}`,
    liveKitUrl: `ws://localhost:${PORTS.signal}`,
    createInvite() {
      const { out } = docker(['exec', names.api, '/server', 'invite', 'create', '--hours', '1']);
      const match = /Código de convite:\s*(\S+)/.exec(out);
      if (!match) {
        throw new Error('não achei o código no retorno do invite create');
      }
      return match[1];
    },
    // Assíncrono de propósito: o aceite observa o app (via CDP) enquanto o backend reinicia.
    async restartBackend() {
      await execFileAsync('docker', ['restart', names.api]);
    },
    backendLogsSince(sinceIso) {
      return docker(['logs', '--since', sinceIso, names.api], { allowFail: true }).out;
    },
    async waitHealthy(timeout = 30_000) {
      return waitFor(() => httpOk(`http://127.0.0.1:${PORTS.api}/health`), {
        timeout,
        interval: 500,
      });
    },
    stop,
  };
}

function logsOf(container) {
  try {
    return execFileSync('docker', ['logs', '--tail', '30', container], { encoding: 'utf8' });
  } catch {
    return '(sem logs)';
  }
}

// Registra a limpeza também para Ctrl+C: sem isso, contêineres e portas ficariam presos até a próxima execução.
export function cleanupOnSignal(cleanup) {
  const handler = async () => {
    console.log('\nInterrompido: removendo o ambiente de teste...');
    try {
      await cleanup();
    } finally {
      await sleep(100);
      process.exit(130);
    }
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}
