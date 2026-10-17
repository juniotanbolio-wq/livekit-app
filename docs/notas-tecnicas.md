# Notas técnicas

Detalhes de implementação, decisões por fase e pegadinhas conhecidas. O `CLAUDE.md` traz só o essencial e aponta para cá. Atualizar ao fim de cada fase.

## Ambiente de desenvolvimento

- Windows + VS Code + Docker Desktop. **Go, gcc e golangci-lint não estão instalados no Windows (e não devem ser sem perguntar)**: todo comando Go roda em contêiner pelos scripts de `backend/scripts/`.
- Scripts em **PowerShell 7** (`pwsh`, 7.6+; todos com `#Requires -Version 7.0`). Rodar a partir de `backend/`: `pwsh -NoProfile -File scripts\<nome>.ps1`.
  - `check.ps1`: generate sem deriva, build, vet, `test -race`, lint (roda todas as etapas e resume).
  - `test.ps1`, `lint.ps1`, `generate.ps1`, `go.ps1 <args>`, `e2e.ps1` (aceite do backend).
  - Caches em volumes Docker `livekit-go-mod`, `livekit-go-build`, `livekit-lint-cache`. Imagens: `golang:1.27`, `golangci/golangci-lint:v2.15.0`.
- Frontend é um projeto npm independente (sem workspace na raiz). Em `frontend/`: `npm run dev`, `dev:second`, `typecheck`, `lint`, `build`, `format`, `generate`, `generate:check`, `e2e`.

## Backend (`backend/`)

- Módulo `livekit-app/backend`, Go 1.27, `net/http` + código gerado do contrato (oapi-codegen v2.8.0, strict server, spec embutida e validada por `nethttp-middleware`), SQLite `modernc.org/sqlite` (1 conexão, WAL), goose (migrações embutidas, aplicadas ao subir), sqlc v1.31.1. Código gerado commitado (`internal/api`, `internal/store`); regenerar com `generate.ps1`.
- Contrato em OpenAPI **3.0.3** (o oapi-codegen não suporta 3.1).
- Comandos do binário: `server [serve]`, `server seed` (7 canais `voice-1..voice-7`, nomes "Voz N", + admin; idempotente), `server invite create [--hours N]`. No contêiner: `docker exec <c> /server invite create`.

### Endpoints (porta 8080)

| Rota | Auth | Notas |
|---|---|---|
| `GET /health` | não | `{status, livekitUrl}` (o `livekitUrl` entrou na R2) |
| `POST /api/auth/register` / `login` | não | `{token, user}`; rate limit por IP compartilhado |
| `GET /api/channels` | Bearer | 7 canais em ordem |
| `POST /api/livekit/token` | Bearer | `{channelId, role: voice\|spectator}` → `{token, url, roomName}` |
| `GET /ws` | 1ª mensagem `{type:"auth",token}` | fora dos `paths` do OpenAPI; mensagens = schemas `Ws*` (`skip-prune: true`) |
| `POST /webhooks/livekit` | assinatura do LiveKit | fora do OpenAPI |

`/ws` e `/webhooks/livekit` ficam num `ServeMux` raiz em `httpapi.NewHandler`, fora da cadeia do validador (que devolveria 404). Erros: `{error, details?}`. Protocolo completo em [protocolo-tempo-real.md](protocolo-tempo-real.md).

### Variáveis (ver `backend/.env.example`)

- Obrigatórias: `JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (segredos com 32+ caracteres).
- Opcionais: `HTTP_ADDR` (:8080), `LOG_LEVEL` (info), `DATABASE_PATH` (data/app.db; na imagem /data/app.db), `JWT_TTL` (7d), `CORS_ORIGINS`, `LIVEKIT_PUBLIC_URL` (ws://localhost:7880), `LIVEKIT_URL` (HTTP interno do LiveKit para o RoomService; padrão deriva do público), `LIVEKIT_TOKEN_TTL` (6h), `INVITE_TTL_HOURS` (72), `AUTH_RATE_LIMIT` (10) / `AUTH_RATE_WINDOW` (15m), `MAX_BODY_BYTES` (32768), `TRUSTED_PROXIES` (vazio; definir na R3 com a rede do Caddy), `RECONCILE_INTERVAL` (60s), `WS_AUTH_TIMEOUT` (5s), `WS_PING_INTERVAL` (20s), `WS_MAX_CONNS_PER_USER` (3), `WS_MAX_CONNS` (200), `MENTION_SENDER_LIMIT` (5) / `MENTION_RECIPIENT_LIMIT` (5) / `MENTION_WINDOW` (30s), `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` (só no `seed`).

### Decisões da R1a (identidade)

- Convite guardado só como SHA-256 (o código em claro só aparece no `invite create`); username único sem diferenciar maiúsculas; senha argon2id (64 MiB, t=3, p=2, no máx. 4 hashes simultâneos); JWT HS256 de sessão.
- Rate limit compartilhado entre register e login, por IP (IPv6 por /64); `X-Forwarded-For` só de `TRUSTED_PROXIES`; origem fora do CORS recebe 403.
- Token LiveKit com todas as permissões explícitas (no LiveKit, `nil` vale `true`), emitido com `livekit/protocol/auth`; sala `channel-<id>`; ids de canal `voice-N`.

### Decisões da R1b (tempo real)

- Presença **só em memória** (`internal/presence`), reconstruída do LiveKit ao iniciar e a cada 60 s (`internal/livekit/roomsync.go`); consulta que falha não aplica nada.
- Eventos idempotentes por `sid` + lápides de 2 min para webhooks fora de ordem. Fora da presença: `hidden` e identidades `#spectator`. Tela = trilha `SCREEN_SHARE`. `participant_left` implica fim da transmissão; `participant_joined` já traz `isScreenSharing`.
- WebSocket: auth pela 1ª mensagem (token fora da URL), snapshot + mudanças com `seq` contíguo, ping 20 s / pong 10 s, fila de saída limitada (lento = desconecta), 3 conexões por usuário (**a mais antiga cai**), fechamentos 1008/1001.
- Menções: só a conectados, sem persistência, ≤ 140 runas, limite por remetente (antes de qualquer consulta ao banco) e por destinatário (só gasto se for entregar).

## Frontend (`frontend/`)

### Decisões da R2

- Tipos gerados de `contracts/openapi.yaml` em `src/generated/` (`api.ts`: REST e `Ws*`; `contract.ts`: limites de validação lidos do YAML), commitados. `openapi-typescript` 7.13 com `overrides` para aceitar o TypeScript 6. Cliente REST com `openapi-fetch` (`src/renderer/src/lib/api.ts`); WebSocket em `lib/realtime.ts`.
- Endereço do servidor pedido na 1ª execução (padrão `http://localhost:8080` fora do pacote), validado pelo **processo principal** com `GET /health` (`net.fetch`, 5 s) e salvo em `userData/settings.json` com o `livekitUrl` devolvido; `http`/`ws` só para localhost. A CSP (`connect-src`) é recalculada a partir dessas duas origens e a página recarrega ao salvar; trocar de servidor apaga a sessão. O renderer confere que a URL do token é da origem do LiveKit salvo.
- 401 em chamada autenticada ou `unauthorized` no WebSocket → login com aviso; sair fecha o WebSocket (1000).
- WebSocket: snapshot em até 10 s, salto de `seq` reconecta, backoff exponencial com full jitter (1 s → 30 s), reconexão no evento `online`; "Conectando..."/"Reconectando..." no topo da barra lateral.
- "Chamar atenção" (R2): só para quem aparece num canal de voz; mensagem opcional (140 runas); erros mapeados (offline, limite com os segundos do servidor). Menção recebida: aviso no app + toast do Windows com som pelo main (`Notification`, `silent:false`, `flashFrame`; loga `notificação de menção exibida`). *Decisão revista na Fase A: passar a valer para qualquer usuário conectado ao WebSocket.*
- Bandeja: o X esconde, "Abrir"/"Sair" no ícone (provisório, desenhado em código até a R4), `backgroundThrottling: false`, `setAppUserModelId`.

## Infra local (`infra/`)

- `docker-compose.yml` sobe **LiveKit + backend** (7880, 7881/TCP, 7882/UDP e 8080, todas em 127.0.0.1 exceto as do LiveKit).
- No dev a chave de API tem nome **fixo `devkey`** (compose `LIVEKIT_KEYS`, backend e `livekit.yaml` `webhook.api_key` precisam coincidir). `infra/.env` precisa de `LIVEKIT_API_SECRET`, `JWT_SECRET` e `SEED_ADMIN_PASSWORD` (os dois últimos gerados na R2, aleatórios).
- O Compose define `CORS_ORIGINS` (padrão: `http://localhost:5173`, `http://127.0.0.1:5173`, `app://desktop`). Webhook do LiveKit: `http://backend:8080/webhooks/livekit`.

## Testes de aceite

- `backend\scripts\e2e.ps1` (R1a + R1b, 63 checks, ~3 min): sobe LiveKit (17880), backend (18080) e bots numa rede Docker descartável, com cópia temporária do `livekit.yaml`, sem tocar no `infra/.env`. O bot `backend/cmd/e2ebot` (server-sdk-go) gera webhooks reais; o cliente WebSocket é `ClientWebSocket` do .NET.
- `frontend\scripts\e2e.mjs` (`npm run e2e`, R2, 50 checks, ~4 min): duas instâncias do app compilado, mídia falsa, dirigidas por CDP (portas 9311/9312). **Hoje usa o Compose de dev** (gera convites, reinicia o `backend`, deixa usuários `e2e_*`): contraria a regra de ambiente isolado; ver `docs/auditoria.md`.

## Pegadinhas conhecidas

### PowerShell
- Variáveis são case-insensitive (`$botS` sobrescrevia `$bots`).
- Array de 1 elemento é "desembrulhado" no retorno de função: use `, @(...)`.
- Com `$ErrorActionPreference = 'Stop'`, stderr de programa nativo pode virar exceção: leia logs de contêiner com `Get-ContainerLog` (troca para `Continue` localmente).
- `ReceiveAsync` do `ClientWebSocket`: cancelar a leitura aborta o socket; espere com timeout sem cancelar.
- No pwsh 7, `ConvertFrom-Json` converte textos de data ISO em `DateTime`.
- A mensagem de commit em here-string passada a um executável nativo pode ser quebrada nas aspas: use `git commit -F <arquivo>`.
- No PowerShell 5.1 (.NET Framework), `"texto".StartsWith([char]0xFEFF)` é comparação cultural e o BOM é ignorável: devolve `$true` para qualquer texto. Use `StartsWith(..., [StringComparison]::Ordinal)`. (Na Fase A isso apagou o `#` da primeira linha dos scripts.)
- Os scripts do backend estão em UTF-8 **sem BOM**: o pwsh 7 os lê certo; o 5.1 leria acentos errado (por isso exigem 7.0).

### Go / backend
- Com a `coder/websocket`, cancelar o contexto no meio de `Write`/`Ping`/`Read` fecha o socket sem handshake: escrita e ping usam `context.WithoutCancel`, e o leitor tem contexto próprio.
- Cliente de teste que não lê o socket não responde ao ping e é derrubado aos ~30 s.
- **Sem acentos em `internal/db/queries/*.sql`** (bug do sqlc com UTF-8).

### Electron / frontend
- **Sem `"type": "module"` no `package.json`**: com ele o electron-vite gera o preload em ESM (`index.mjs`), que não carrega com `sandbox: true` (o app abre sem `window.desktop`).
- Seletor Zustand nunca devolve `[]` ou objeto novo a cada leitura: laço infinito de renderização (erro React #185). Use uma constante.
- O ambiente do VS Code/Claude Code exporta `ELECTRON_RUN_AS_NODE`: remova-o para lançar o Electron por script, senão ele roda como Node ("bad option").
- `window.close()` pelo renderer fecha a janela sem o evento `close` do `BrowserWindow` (pula o "esconder na bandeja"); para simular o X, mande `WM_CLOSE`.
- Com `backgroundThrottling: false`, `document.visibilityState` fica sempre `visible`; para saber se a janela está escondida, use o Windows (`MainWindowHandle` = 0).
- `--use-fake-device-for-media-stream` também troca a captura de tela pelo padrão animado do Chromium (1920x1080@60); o seletor continua listando as telas reais.
- O backend limita cadastro + login a 10 por 15 min por IP: rodar o aceite várias vezes seguidas esbarra nisso (`docker compose restart backend` zera, o limite é em memória).
