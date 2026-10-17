# Projeto: app de comunicação em tempo real com LiveKit (grupo fechado, até 15 pessoas)

## Visão

App desktop para Windows (Electron), estilo Discord simplificado: 1 canal de texto persistente e 7 canais de voz/vídeo, com Modo Espectador Multicanal e compartilhamento de tela 1080p60 com áudio. Backend e servidor de mídia em servidor próprio na internet.

## Stack

- Monorepo com npm workspaces: apps/server, apps/desktop, packages/shared (tipos e schemas zod), infra
- TypeScript estrito em tudo
- Server: Node.js LTS, Express, livekit-server-sdk, Prisma + SQLite, Socket.IO, zod, argon2, jsonwebtoken, helmet, express-rate-limit
- Desktop: Electron + electron-vite, React, Tailwind CSS, @livekit/components-react, livekit-client, Zustand
- Mídia: LiveKit Server via Docker Compose. Dev local no Windows com Docker Desktop; produção em VPS Linux própria

## Decisões de arquitetura

- 1 sala LiveKit por canal de voz/vídeo. O texto fica fora do LiveKit: Socket.IO para tempo real + SQLite para histórico (paginação por cursor, limite de 2000 caracteres por mensagem)
- Cadastro: código de convite de uso único com expiração, gerado por script de admin. Registro com código + usuário + senha (argon2). Login retorna JWT. Primeiro admin criado por seed
- Os 8 canais são fixos e criados por seed
- Token LiveKit: endpoint autenticado que recebe channelId e role
  - voice: publica e assina áudio/vídeo
  - spectator: hidden, sem publicar, o cliente usa autoSubscribe false e assina só a trilha de vídeo da tela compartilhada
- Modo Espectador: o cliente mantém duas conexões Room simultâneas (voz no canal X, espectador no canal Y)
- Tela: captura 1920x1080 a 60fps, maxBitrate ~8 Mbps, contentHint motion, simulcast
- Áudio: primeiro loopback do sistema via Electron. Captura por aplicativo (WASAPI process loopback com módulo nativo) fica para fase futura
- livekit.yaml com tcp_port 7881 e udp_port único (mux) para simplificar Docker no Windows
- Deploy público (domínio, TLS com Caddy, TURN) fica para fase futura; configuração sempre por variáveis de ambiente

## Fases

1. Fundação: monorepo, shared, infra LiveKit, esqueleto dos apps (concluída)
   1A. Backend: Prisma/SQLite, convites, registro, login JWT, seed, canais, token LiveKit, histórico por cursor, Socket.IO (concluída)
   1B. Desktop: login/registro, layout, chat persistente, voz/vídeo, presença (concluída)
2. Compartilhamento de tela com áudio loopback
3. Modo Espectador multicanal
4. Instalador e deploy público

## Estado atual

### Comandos (raiz, PowerShell)

- `docker compose up -d` dentro de `infra` (ou `npm run infra:up`): sobe o LiveKit
- `npm run db:migrate`, `npm run db:seed`, `npm run invite:create [-- --hours N]`
- `npm run dev`: shared em watch + server; `npm run dev:desktop`: Vite + Electron; `npm run dev:second`: segunda janela (exige o `dev:desktop` rodando; perfil em `apps/desktop/.electron-second`, sem trava de instância única)
- `npm run typecheck | lint | build | format`

### Portas

- 3000 server HTTP + Socket.IO; 5173 Vite do renderer (fixa, `strictPort`)
- 7880 LiveKit HTTP/WS; 7881 TCP do RTC; 7882 UDP (mux)

### Endpoints

- `GET /health`
- `POST /api/auth/register`, `POST /api/auth/login` (rate limit 10/15min por IP)
- `GET /api/channels`, `GET /api/channels/:id/messages?before=&limit=` (do mais novo ao mais antigo, `nextCursor`)
- `POST /api/livekit/token` `{ channelId, role: voice|spectator }` → `{ token, url: LIVEKIT_PUBLIC_URL, roomName }`
- `GET /api/presence` → `{ channels: [{ channelId, participants: [{ userId, username, isScreenSharing }] }] }`, ignora `hidden` e identidades `#spectator`, cache `PRESENCE_CACHE_MS`, 503 se o LiveKit cair
- Socket.IO com `auth: { token }`: `message:send` (ack `{ ok, data | error }`) e `message:new`; todos entram nas salas dos canais de texto

### Variáveis de ambiente

- `apps/server/.env`: `NODE_ENV`, `HOST`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGINS` (dev: `http://localhost:5173,http://127.0.0.1:5173,app://desktop`), `LIVEKIT_URL` (interna, `http://`), `LIVEKIT_PUBLIC_URL` (para clientes, `ws://`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_TOKEN_TTL`, `PRESENCE_CACHE_MS`, `INVITE_TTL_HOURS`, `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`
- `infra/.env`: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (iguais aos do server), `LIVEKIT_NODE_IP` (IP anunciado; `127.0.0.1` só serve para clientes na mesma máquina)
- Desktop (processo main, lidas ao abrir): `LIVEKIT_APP_SERVER_URL` (padrão `http://localhost:3000`) e `LIVEKIT_APP_LIVEKIT_URL` (padrão `ws://localhost:7880`, usada na CSP)

### Decisões do desktop

- Main: `contextIsolation`, `sandbox`, sem `nodeIntegration`; CSP por cabeçalho (`security.ts`) com `connect-src` só para server e LiveKit; em dev libera `'unsafe-inline'` em script para o React Refresh; em produção o renderer é servido por `app://desktop` (`protocol.handle`)
- Permissões: só `media` e `speaker-selection` para a origem do app; navegação, redirect, webview e `window.open` bloqueados
- Sessão `{ token, user }` cifrada com `safeStorage` em `userData/session.bin`; IPC tipado (`src/shared/desktop-api.ts`) com remetente verificado e payload validado com zod; argumentos `--user-data-dir=`, `--multi-instance` e `--renderer-url=` (este só fora do app empacotado)
- Renderer: stores Zustand em `src/renderer/src/stores` (session, channels, chat, presence, voice); `lib/api.ts` valida respostas com os schemas do shared e um 401 volta para o login; `lib/realtime.ts` cuida do Socket.IO, com reconexão e ressincronização do histórico
- Voz: um único `Room` criado no `VoiceProvider` (acima das telas) com `RoomContext` e `RoomAudioRenderer`; a área central só lê o estado, então trocar de tela ou de canal visualizado não derruba a voz. Clicar num canal de voz já entra nele. Deafen silencia a saída e muta o mic, restaurando ao voltar
- Dispositivos (mic, câmera, saída) ficam salvos em `localStorage` e são aplicados com `switchActiveDevice`; a listagem é feita por tipo, para a falta de câmera não esconder os microfones
- Em dev, reiniciar o `npm run dev` da raiz recompila o shared e faz o Vite recarregar o renderer (a voz cai); para reiniciar só o server use `npm run dev -w @livekit-app/server`

## Estrutura e comandos

- `packages/shared`: ESM, compilado com tsc para `dist`; o `postinstall` da raiz e os scripts `dev`/`build`/`typecheck` compilam antes dos apps
- `apps/server`: ESM; em dev usa `node --watch --import tsx` (o `tsx watch` trava dentro do `concurrently` no Windows); `tsc` no build; config por env validada com zod em `src/config.ts`, lê `apps/server/.env` se existir
- Prisma 7.10.1 fixo (o `latest` do npm é 8.0.0-rc), adapter `@prisma/adapter-better-sqlite3`, client gerado em `apps/server/src/generated/prisma` (ignorado no git; `prisma generate` roda em dev/build/typecheck), config em `apps/server/prisma.config.ts`
- npm 11 exige `allowScripts` no `package.json` da raiz para pacotes com install scripts (argon2, better-sqlite3, prisma, esbuild)
- Rotas: `src/routes`, regras em `src/services`, Socket.IO em `src/realtime/socket.ts`, scripts de seed e convite em `src/scripts`
- `apps/desktop`: electron-vite; main e preload saem em CJS, renderer em `src/renderer`, tipos compartilhados main/preload/renderer em `src/shared`
- `infra`: `docker-compose.yml` + `livekit.yaml`; chaves em `infra/.env` (variável `LIVEKIT_KEYS` montada pelo compose)
- Raiz: `npm run dev | dev:desktop | dev:second | build | typecheck | lint | format | db:migrate | db:seed | invite:create | infra:up | infra:down | infra:logs`

## Regras de código

- NÃO escrever comentários no código
- Sem placeholders, sem "resto do código aqui"; arquivos completos
- Validar entradas com zod nas bordas; tratar erros; nunca commitar .env (manter .env.example)
- Scripts npm em todos os workspaces: dev, build, typecheck, lint

## Regras de trabalho

- Antes de cada fase, apresentar plano curto e esperar aprovação
- Não adicionar escopo fora da fase pedida
- Ao terminar: rodar typecheck e build, relatar resultado e listar suposições feitas
- Respostas e mensagens de commit em português
