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
- Modo Espectador: segunda conexão com identidade `<id>#spectator`, hidden, sem publicar, `autoSubscribe: false`, assinando só o vídeo de screen share do canal assistido (e, se ligado, o áudio dele). Nunca assinar microfone ou câmera desse canal.
- Assistir sob demanda (Fase Q): a sala de voz também usa `autoSubscribe: false`. Microfones e câmeras (camada média) são assinados automaticamente; a tela só ao clicar em "Assistir", sem prévia. "Parar de assistir" cancela a assinatura. Dynacast ligado.
- Quem assiste recebe sempre a camada máxima: `adaptiveStream` desligado nas duas salas. Camada menor só quando a rede de quem assiste não comporta (decisão do SFU).
- Tela: 1080p60, ~6 a 10 Mbps, `contentHint: motion`, `degradationPreference: maintain-resolution` (em sobrecarga cai o fps, nunca a resolução). Simulcast para H.264/VP8; SVC L1T3 para VP9/AV1.
- Codificador por hardware é prioridade. Codec "Automático": H.264 por GPU > AV1 por GPU > H.264 em software, confirmado por `encoderImplementation`/`powerEfficientEncoder`. No Windows exige as features do Chromium em `frontend/src/main/media-flags.ts`.
- Voz: Opus 64 kbps com RED e DTX; eco e ganho automático sempre ligados; supressão de ruído Desligada / Padrão (nativa) / Avançada (RNNoise local); noise gate opcional. Áudio do stream: Opus estéreo ~128 kbps, sem processamento de voz, opcional para quem assiste (ligado por padrão, escolha salva).
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
- Teste instável não conta como aprovado: investigar e corrigir a causa. Nunca aceitar "passou na segunda".
- Toda fase que mexe no frontend abre o app de verdade (smoke test), além dos testes automatizados.
- Testes sempre em ambiente isolado (contêineres, portas e banco próprios e descartáveis), sem tocar no banco nem nas portas de desenvolvimento.
- Segredos gerados com gerador criptográfico, validados (tamanho, não-repetidos, não-zerados) e nunca exibidos no chat nem em logs.
- Ao terminar: build, lint e testes; atualizar "Estado atual" abaixo e `docs/notas-tecnicas.md`; commit e `git push` da branch.
- Relatório final em três blocos: **validado automaticamente**, **validado só com mídia falsa** e **precisa de teste real do usuário**; mais o que falhou e as suposições.
- Respostas e mensagens de commit em português.
- Ambiente de desenvolvimento: Windows + VS Code + GitHub (repositório privado). Servidor: Ubuntu LTS na rede de casa. Comandos no servidor são executados pelo usuário via SSH; gerar scripts e guias para isso.

## Estado atual
Resumo; detalhes (endpoints, variáveis, decisões por fase e pegadinhas) em [docs/notas-tecnicas.md](docs/notas-tecnicas.md). **Leia as pegadinhas de lá antes de mexer em scripts PowerShell, Electron, Zustand ou WebSocket.** Atualizar os dois ao fim de cada fase.
- R0, R1a, R1b, R2, Fase A (auditoria, `docs/auditoria.md`) e Fase Q (qualidade de áudio e vídeo, `docs/medicoes.md`) concluídas. v1 preservada na tag `v1-node`; trabalho na branch `v2`.
- **Go, gcc e golangci-lint NÃO estão instalados no Windows (e não devem ser sem perguntar).** Todo comando Go roda em Docker pelos scripts de `backend/scripts/`, em PowerShell 7: `pwsh -NoProfile -File scripts\check.ps1` (generate sem deriva, build, vet, `test -race`, lint) e `scripts\e2e.ps1` (aceite isolado). Também `test.ps1`, `lint.ps1`, `generate.ps1`, `go.ps1`.
- Frontend (projeto npm em `frontend/`): `npm run dev`, `dev:second`, `typecheck`, `lint`, `build`, `test` (unitários), `generate` / `generate:check` (tipos do contrato), `e2e` (aceite com duas instâncias por CDP, em servidor descartável: portas 27880-27882 e 28080), `medir` (tabela de `docs/medicoes.md`) e `package` (`.exe` portátil + `dist/win-unpacked`).
- Dev local: `infra/docker-compose.yml` (LiveKit 7880/7881/7882 + backend em 127.0.0.1:8080, chave `devkey`); no app, servidor `http://localhost:8080`. Segredos em `infra/.env` (não versionado). "Iniciar teste" (`infra/scripts/iniciar-teste.ps1`, atalho por `criar-atalho.ps1`) sobe o Compose e abre duas instâncias do app empacotado.
- Contrato: `contracts/openapi.yaml` (OpenAPI 3.0.3) gera Go (`backend/internal/api`) e TypeScript (`frontend/src/generated`); os dois são commitados e checados contra deriva.
- Próxima fase: R3 (servidor caseiro: Compose de produção com Caddy e TLS, TURN, scripts do Ubuntu e `docs/servidor.md`), depois de corrigidos os achados aprovados da auditoria. A Fase Q resolveu T1, T4, M2, M3 e M4 (H.264 por GPU medido na AMD); M1 e M5 dependem do teste real do usuário (checklist em `docs/medicoes.md`).
