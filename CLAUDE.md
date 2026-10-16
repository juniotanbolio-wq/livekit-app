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
2. Desktop base: login/registro, layout, chat de texto
3. Voz/vídeo
4. Compartilhamento de tela com áudio loopback
5. Modo Espectador

## Estrutura e comandos

- `packages/shared`: ESM, compilado com tsc para `dist`; o `postinstall` da raiz e os scripts `dev`/`build`/`typecheck` compilam antes dos apps
- `apps/server`: ESM; em dev usa `node --watch --import tsx` (o `tsx watch` trava dentro do `concurrently` no Windows); `tsc` no build; config por env validada com zod em `src/config.ts`, lê `apps/server/.env` se existir
- Prisma 7.10.1 fixo (o `latest` do npm é 8.0.0-rc), adapter `@prisma/adapter-better-sqlite3`, client gerado em `apps/server/src/generated/prisma` (ignorado no git; `prisma generate` roda em dev/build/typecheck), config em `apps/server/prisma.config.ts`
- npm 11 exige `allowScripts` no `package.json` da raiz para pacotes com install scripts (argon2, better-sqlite3, prisma, esbuild)
- Rotas: `src/routes`, regras em `src/services`, Socket.IO em `src/realtime/socket.ts`, scripts de seed e convite em `src/scripts`
- `apps/desktop`: electron-vite; main e preload saem em CJS, renderer em `src/renderer`
- `infra`: `docker-compose.yml` + `livekit.yaml`; chaves em `infra/.env` (variável `LIVEKIT_KEYS` montada pelo compose)
- Raiz: `npm run dev | dev:desktop | build | typecheck | lint | format | db:migrate | db:seed | invite:create | infra:up | infra:down | infra:logs`

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
