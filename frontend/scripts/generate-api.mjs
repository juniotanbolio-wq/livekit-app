// Gera os tipos TypeScript do cliente a partir de contracts/openapi.yaml (fonte única do contrato).
//
//   npm run generate         escreve src/generated/api.ts e src/generated/contract.ts
//   npm run generate:check   só confere: falha se os arquivos commitados estiverem desatualizados
//
// api.ts tem os tipos de REST e das mensagens do WebSocket (schemas Ws*). contract.ts tem os limites de
// validação (tamanhos, padrão do nome de usuário): o openapi-typescript só gera tipos, e os formulários do
// cliente precisam seguir as mesmas regras do servidor sem que ninguém as copie à mão.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { parse } from 'yaml';

const specUrl = new URL('../../contracts/openapi.yaml', import.meta.url);
const outDir = new URL('../src/generated/', import.meta.url);
const checkOnly = process.argv.includes('--check');

const HEADER = [
  '// Gerado por scripts/generate-api.mjs a partir de contracts/openapi.yaml.',
  '// Não edite à mão: altere o contrato e rode `npm run generate`.',
  '',
].join('\n');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Lê um caminho dentro do documento e exige que o valor exista e tenha o tipo esperado: se o contrato mudar
// de forma incompatível, a geração quebra aqui em vez de produzir limites errados em silêncio.
function pick(doc, path, type) {
  let value = doc;
  for (const key of path) {
    value = value?.[key];
  }
  if (typeof value !== type) {
    fail(
      `contracts/openapi.yaml: esperava ${type} em ${path.join('.')}, encontrei ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function generateTypes() {
  const ast = await openapiTS(specUrl, { silent: true });
  return HEADER + astToString(ast);
}

async function generateLimits() {
  const doc = parse(await readFile(specUrl, 'utf8'));
  const schemas = ['components', 'schemas'];
  const register = [...schemas, 'RegisterRequest', 'properties'];
  const limits = {
    USERNAME_MIN_LENGTH: pick(doc, [...schemas, 'Username', 'minLength'], 'number'),
    USERNAME_MAX_LENGTH: pick(doc, [...schemas, 'Username', 'maxLength'], 'number'),
    PASSWORD_MIN_LENGTH: pick(doc, [...register, 'password', 'minLength'], 'number'),
    PASSWORD_MAX_LENGTH: pick(doc, [...register, 'password', 'maxLength'], 'number'),
    INVITE_CODE_MIN_LENGTH: pick(doc, [...register, 'inviteCode', 'minLength'], 'number'),
    INVITE_CODE_MAX_LENGTH: pick(doc, [...register, 'inviteCode', 'maxLength'], 'number'),
    // Contado em caracteres Unicode (runas no servidor Go), não em unidades UTF-16.
    MENTION_MESSAGE_MAX_LENGTH: pick(
      doc,
      [...schemas, 'WsClientMention', 'properties', 'message', 'maxLength'],
      'number',
    ),
  };
  const pattern = pick(doc, [...schemas, 'Username', 'pattern'], 'string');
  const lines = [
    HEADER,
    '// Limites de validação do contrato, para o cliente validar com as mesmas regras do servidor.',
    ...Object.entries(limits).map(([name, value]) => `export const ${name} = ${value};`),
    `export const USERNAME_PATTERN = new RegExp(${JSON.stringify(pattern)});`,
    '',
  ];
  return lines.join('\n');
}

const normalize = (text) => text.replace(/\r\n/g, '\n');

async function main() {
  const files = {
    'api.ts': await generateTypes(),
    'contract.ts': await generateLimits(),
  };

  if (checkOnly) {
    const stale = [];
    for (const [name, content] of Object.entries(files)) {
      const current = await readFile(new URL(name, outDir), 'utf8').catch(() => null);
      if (current === null || normalize(current) !== normalize(content)) {
        stale.push(`src/generated/${name}`);
      }
    }
    if (stale.length > 0) {
      fail(
        `Código gerado desatualizado em relação a contracts/openapi.yaml: ${stale.join(', ')}. Rode \`npm run generate\` e commite.`,
      );
    }
    console.log('Código gerado em dia com contracts/openapi.yaml.');
    return;
  }

  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(new URL(name, outDir), content, 'utf8');
    console.log(`escrito ${fileURLToPath(new URL(name, outDir))}`);
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
