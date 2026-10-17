# CLAUDE.md

## Projeto
App desktop de comunicação em tempo real para um grupo fechado (até 15 pessoas, até ~5 transmissões simultâneas).
Prioridade máxima: áudio e vídeo com qualidade e baixa latência, com compartilhamento de tela em 1080p a 60 fps.
Não há chat de texto. Existe a função "chamar atenção" (menção a um usuário).
Plano completo, fases e critérios de aceite: `docs/plano-v2.md`.

## Estrutura do repositório
- `frontend/`: cliente desktop Windows (Electron + React + TypeScript). Vira um `.exe`. Não contém segredos. O endereço do servidor é configurado na tela.
- `backend/`: API em Go. Identidade, convites, canais, tokens LiveKit, presença em tempo real, menções. Futuro: agenda.
- `infra/`: LiveKit Server (SFU de mídia), Caddy (TLS), Docker Compose e scripts para o servidor Ubuntu LTS na rede de casa.
- `contracts/`: `openapi.yaml`, contrato único entre frontend e backend. Tipos são gerados a partir dele, nunca escritos à mão nos dois lados.
- `docs/`: arquitetura, protocolos, guia do servidor e plano.
- Todo diretório principal tem um `README.md` curto: o que é, como rodar, o que contém.

## Fluxos
- Mídia: cliente <-> LiveKit via WebRTC (UDP 7882; reserva TCP 7881 e TURN). O backend nunca toca na mídia.
- Controle: cliente <-> backend via HTTPS (REST) e WSS (eventos de presença e menções).
- LiveKit -> backend via webhooks assinados (presença e quem está transmitindo).
- Caddy na porta 443 faz TLS para o backend e para a sinalização do LiveKit.

## Stack
- Backend: Go (versão estável atual), `net/http` da biblioteca padrão, `oapi-codegen`, SQLite com `modernc.org/sqlite` (sem cgo), `sqlc`, `goose` (migrações), `livekit/server-sdk-go/v2`, `coder/websocket`, `golang-jwt/jwt/v5`, argon2id (`golang.org/x/crypto`), `log/slog`, `golangci-lint`.
- Frontend: Electron + electron-vite, React, TypeScript estrito, Tailwind, `livekit-client`, `@livekit/components-react`, Zustand, `openapi-typescript` + `openapi-fetch`, `electron-builder` (exe portátil e instalador NSIS).
- Infra: Ubuntu Server LTS, Docker Compose, LiveKit, Caddy, ufw.

## Decisões de mídia (não mudar sem discutir comigo)
- WebRTC via LiveKit. O SFU repassa os pacotes, não recodifica.
- 1 sala LiveKit por canal de voz (7 canais).
- Modo Espectador: segunda conexão com identidade `<id>#spectator`, hidden, sem publicar, `autoSubscribe: false`, assinando só o vídeo de screen share do canal assistido. Nunca assinar microfone ou câmera desse canal.
- Tela: 1080p60, ~6 a 10 Mbps, `contentHint: motion`, `degradationPreference: maintain-framerate`. Simulcast para H.264/VP8; SVC L1T3 para VP9/AV1.
- Codificador por hardware é prioridade: medir `encoderImplementation` nas estatísticas WebRTC e preferir o codec com aceleração da GPU, com fallback.
- Voz: Opus com DTX, cancelamento de eco e supressão de ruído. Áudio do stream: Opus estéreo ~128 kbps, opcional para o espectador.
- Loopback de áudio do sistema desligado por padrão. Captura por aplicativo é fase futura.
- Sem FTP. UDP apenas através do WebRTC.

## Regras de código
- Comentários em português explicando o porquê, não o óbvio. Obrigatórios em: mídia, rede, permissões de token, concorrência em Go e segurança do Electron.
- Arquivos completos, sem placeholders. Erros sempre tratados.
- Segredos só em `.env` (nunca commitar). Manter `.env.example` atualizado.
- Backend: `context.Context` em toda chamada externa, timeouts no `http.Server`, nenhuma goroutine vazada, testes com `go test -race`.
- Frontend: manter contextIsolation, nodeIntegration desligado, CSP estrita e sessão cifrada com safeStorage.

## Regras de trabalho
- Uma fase por vez, conforme `docs/plano-v2.md`. Não adicionar escopo fora da fase.
- Antes de codar, apresentar um plano curto e esperar aprovação.
- Ao terminar: build, lint e testes; relatório com o que passou, o que falhou e as suposições; atualizar "Estado atual" abaixo; commit.
- Respostas e mensagens de commit em português.
- Ambiente de desenvolvimento: Windows + VS Code + GitHub (repositório privado). Servidor: Ubuntu LTS na rede de casa. Comandos no servidor são executados pelo usuário via SSH; gerar scripts e guias para isso.

## Estado atual
Atualizar ao fim de cada fase: comandos, portas, endpoints, variáveis de ambiente e decisões tomadas.
- R0, R1a, R1b e R2 concluídas. v1 (backend Node + Electron + chat) preservada na tag `v1-node`; trabalho na branch `v2`.
- Frontend é um projeto npm independente (sem workspace na raiz). Comandos em `frontend/`: `npm install`, `npm run dev`, `npm run dev:second`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run generate` / `npm run generate:check` (tipos do contrato) e `npm run e2e` (aceite da R2). **Sem `"type": "module"` no `package.json`**: com ele o electron-vite gera o preload em ESM (`index.mjs`), que não carrega com `sandbox: true`.
- Chat e Socket.IO removidos; canais só de voz. Tipos gerados de `contracts/openapi.yaml` em `frontend/src/generated/` (`api.ts` com REST e `Ws*`; `contract.ts` com limites de validação lidos do YAML), commitados; `openapi-typescript` 7.13 com `overrides` para aceitar o TypeScript 6. Cliente REST com `openapi-fetch` (`src/renderer/src/lib/api.ts`), WebSocket em `lib/realtime.ts`. Sem polling de presença.
- **Go, gcc e golangci-lint NÃO estão instalados no Windows (e não devem ser sem perguntar).** Todo comando Go roda em Docker pelos scripts de `backend/scripts/` (PowerShell; invocar com `powershell -ExecutionPolicy Bypass -File scripts\<nome>.ps1`, a partir de `backend/`): `check.ps1` (generate sem deriva, build, vet, `test -race`, lint), `test.ps1`, `lint.ps1`, `generate.ps1`, `go.ps1 <args>` e `e2e.ps1` (aceite). Detalhes no `backend/README.md`. Caches em volumes Docker `livekit-go-mod`, `livekit-go-build`, `livekit-lint-cache`. Lint: `golangci/golangci-lint:v2.15.0`.
- Backend (`backend/`, módulo `livekit-app/backend`, Go 1.27): `net/http` + código gerado do `contracts/openapi.yaml` (oapi-codegen v2.8.0, strict server, spec embutida e validada por `nethttp-middleware`) + SQLite `modernc.org/sqlite` (1 conexão, WAL) + goose (migrações embutidas, aplicadas ao subir) + sqlc v1.31.1. Código gerado é commitado (`internal/api`, `internal/store`); regenerar com `scripts\generate.ps1`. **Sem acentos em `internal/db/queries/*.sql`** (bug do sqlc com UTF-8).
- Endpoints (porta 8080): `GET /health` (`{status, livekitUrl}`; desde a R2), `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/channels` (Bearer), `POST /api/livekit/token` (Bearer; `{channelId, role: voice|spectator}`). Erros: `{error, details?}`. Contrato em OpenAPI **3.0.3** (o oapi-codegen não suporta 3.1).
- Endpoints da R1b (mesma porta): `GET /ws` (WebSocket; **1ª mensagem** `{type:"auth",token}`, nunca token na URL) e `POST /webhooks/livekit` (assinado pelo LiveKit). Ficam **fora** do OpenAPI `paths` (montados em um `ServeMux` raiz em `httpapi.NewHandler`, porque o validador devolveria 404), mas as mensagens do WebSocket são schemas `Ws*` em `components/schemas` (`skip-prune: true` no oapi-codegen). Protocolo completo em `docs/protocolo-tempo-real.md`.
- Comandos do binário: `server [serve]`, `server seed` (7 canais `voice-1..voice-7` + admin, idempotente), `server invite create [--hours N]`. No contêiner: `docker exec <c> /server invite create`.
- Variáveis (ver `backend/.env.example`): obrigatórias `JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (32+ caracteres os segredos); opcionais `HTTP_ADDR` (:8080), `LOG_LEVEL` (info), `DATABASE_PATH` (data/app.db; na imagem /data/app.db), `JWT_TTL` (7d), `CORS_ORIGINS`, `LIVEKIT_PUBLIC_URL` (ws://localhost:7880), `LIVEKIT_TOKEN_TTL` (6h), `INVITE_TTL_HOURS` (72), `AUTH_RATE_LIMIT` (10) / `AUTH_RATE_WINDOW` (15m), `MAX_BODY_BYTES` (32768), `TRUSTED_PROXIES` (vazio; definir na R3 com a rede do Caddy), `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` (só no `seed`). R1b: `LIVEKIT_URL` (HTTP interno do LiveKit para o RoomService; padrão deriva de `LIVEKIT_PUBLIC_URL`), `RECONCILE_INTERVAL` (60s), `WS_AUTH_TIMEOUT` (5s), `WS_PING_INTERVAL` (20s), `WS_MAX_CONNS_PER_USER` (3), `WS_MAX_CONNS` (200), `MENTION_SENDER_LIMIT` (5) / `MENTION_RECIPIENT_LIMIT` (5) / `MENTION_WINDOW` (30s).
- Decisões da R1a: convite guardado só como SHA-256 (código em claro só aparece no `invite create`); username único sem diferenciar maiúsculas; senha argon2id (64 MiB, t=3, p=2, no máx. 4 hashes simultâneos); JWT HS256 de sessão; rate limit compartilhado entre register e login, por IP (IPv6 por /64), `X-Forwarded-For` só de `TRUSTED_PROXIES`; origem fora do CORS recebe 403; token LiveKit com todas as permissões explícitas (nil vale true no LiveKit) usando só `livekit/protocol/auth` (a `server-sdk-go/v2` entra na R1b); sala `channel-<id>`; ids de canal `voice-N`.
- Ambiente local: `infra/docker-compose.yml` sobe **LiveKit + backend** (portas 7880, 7881/TCP, 7882/UDP e 8080 em 127.0.0.1). No dev a chave de API tem nome **fixo `devkey`** (compose `LIVEKIT_KEYS`, backend e `livekit.yaml` `webhook.api_key` precisam coincidir); `infra/.env.example` pede `LIVEKIT_API_SECRET`, `JWT_SECRET` e `SEED_ADMIN_PASSWORD` (no `.env` real os dois últimos foram gerados na R2, aleatórios). O Compose define `CORS_ORIGINS` (padrão: Vite `http://localhost:5173`, `http://127.0.0.1:5173` e `app://desktop`). Webhook do LiveKit: `http://backend:8080/webhooks/livekit`. O `e2e.ps1` não usa esse Compose: sobe LiveKit (17880), backend (18080) e bots numa rede Docker descartável, com cópia temporária do `livekit.yaml`, sem tocar no `infra/.env`.
- Decisões da R1b: presença **só em memória** (`internal/presence`), reconstruída do LiveKit ao iniciar e a cada 60 s (`internal/livekit/roomsync.go`; consulta falha = nada aplicado). Eventos idempotentes por `sid` + lápides de 2 min para webhooks fora de ordem. Fora da presença: `hidden` e identidades `#spectator`. Tela = track `SCREEN_SHARE`. `participant_left` implica fim da transmissão; `participant_joined` já traz `isScreenSharing`. WebSocket: auth por 1ª mensagem (token fora da URL), snapshot + mudanças com `seq` contíguo (salto = reconectar), ping 20 s/pong 10 s, fila de saída limitada (lento = desconecta), 3 conexões por usuário (**a mais antiga cai**), códigos de fechamento 1008/1001. Menções: só a conectados, sem persistência, ≤140 runas, limite por remetente (antes de qualquer consulta ao banco) e por destinatário (só gasto se for entregar). Armadilhas conhecidas: com a `coder/websocket`, cancelar o contexto no meio de `Write`/`Ping`/`Read` fecha o socket sem handshake (por isso escrita/ping usam `context.WithoutCancel` e o leitor tem contexto próprio); cliente de teste que não lê o socket não responde ao ping e é derrubado aos ~30 s.
- Aceite: `backend\scripts\e2e.ps1` (R1a + R1b, ~63 checks, ~3 min) usa o bot `backend/cmd/e2ebot` (server-sdk-go) para gerar webhooks reais e um cliente `ClientWebSocket` em PowerShell. Pegadinhas do PowerShell 5.1 já resolvidas lá: variáveis são case-insensitive (`$botS` sobrescrevia `$bots`), array de 1 elemento é "desembrulhado" no retorno de função, `$ErrorActionPreference='Stop'` transforma stderr de programa nativo em exceção (use `Get-ContainerLog`).
- Decisões da R2: endereço do servidor pedido na 1ª execução (padrão `http://localhost:8080` fora do pacote), validado pelo **processo principal** com `GET /health` (`net.fetch`, 5 s) e salvo em `userData/settings.json` com o `livekitUrl` devolvido; `http`/`ws` só para localhost. A CSP (`connect-src`) é recalculada a partir dessas duas origens e a página recarrega ao salvar; trocar de servidor apaga a sessão. O renderer confere que a URL do token é da origem do LiveKit salvo (senão pede para revalidar em Configurações > Servidor). 401 em chamada autenticada ou `unauthorized` no WebSocket → login com aviso; sair fecha o WebSocket (1000). WebSocket: snapshot em até 10 s, salto de `seq` reconecta, backoff exponencial com full jitter (1 s → 30 s) e reconexão no evento `online`; "Conectando..."/"Reconectando..." no topo da barra lateral. "Chamar atenção" só para quem aparece num canal de voz (decisão do usuário; o protocolo não lista quem só está com o app aberto), com mensagem opcional (140 runas), erros mapeados (offline, limite com os segundos do servidor). Menção recebida: aviso no app + toast do Windows com som pelo main (`Notification`, `silent:false`, `flashFrame`; loga `notificação de menção exibida`). Bandeja: o X esconde, "Abrir"/"Sair" no ícone (provisório, desenhado em código até a R4), `backgroundThrottling: false`, `setAppUserModelId`. Armadilhas: seletor Zustand nunca devolve `[]`/objeto novo (laço infinito, erro React #185); o ambiente do VS Code/Claude Code exporta `ELECTRON_RUN_AS_NODE`, que precisa ser removido para lançar o Electron por script.
- Aceite da R2: `frontend\scripts\e2e.mjs` (`npm run e2e`, 50 checks, ~4 min) usa o Compose de dev (gera convites, reinicia o `backend`, deixa usuários `e2e_*`), sobe duas instâncias do app compilado com mídia falsa e as dirige por CDP (portas 9311/9312). A flag de mídia falsa também troca a captura de tela pelo padrão animado do Chromium (1920x1080@60). Fechar a janela é simulado com `WM_CLOSE` (o `window.close()` do renderer pula o evento `close`); "escondida" é conferida pelo `MainWindowHandle` (com `backgroundThrottling: false` o `visibilityState` fica sempre `visible`). Cada execução gasta 3 das 10 autenticações por 15 min do backend de dev (`docker compose restart backend` zera).
- Próxima fase: R3 (servidor caseiro: Compose de produção com Caddy e TLS, TURN, scripts do Ubuntu e `docs/servidor.md`).
