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
- R0 concluída. v1 (backend Node + Electron + chat) preservada na tag `v1-node`; trabalho na branch `v2`.
- Frontend é um projeto npm independente (sem workspace na raiz). Comandos em `frontend/`: `npm install`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm run build`.
- Chat e Socket.IO removidos. Canais agora são só de voz. Presença segue por polling de 5 s até a R1b/R2 (sem backend funcional até lá). Tipos provisórios em `frontend/src/api/types.ts` (substituídos pelo OpenAPI na R2).
- Backend (`backend/`): módulo Go `livekit-app/backend`, esqueleto com `GET /health` na porta 8080. Variáveis: `HTTP_ADDR` (:8080), `LOG_LEVEL` (info), `DATABASE_PATH` (data/app.db). Comandos: `go build ./...`, `go vet ./...`, `go test -race ./...`, `golangci-lint run`, `docker build`.
- `go test -race` exige cgo; no Windows sem gcc, rodar via Docker (`golang:1.27`), ver `backend/README.md`.
- LiveKit local: `infra/docker-compose.yml` (portas 7880, 7881/TCP, 7882/UDP).
- Próxima fase: R1a (backend Go, base e identidade).
