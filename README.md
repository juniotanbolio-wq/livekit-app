# LiveKit App (v2)

App desktop de comunicação em tempo real para um grupo fechado (até 15 pessoas, até ~5 transmissões simultâneas), com voz, vídeo e compartilhamento de tela em 1080p60 via LiveKit. Não há chat de texto.

Plano e fases: [docs/plano-v2.md](docs/plano-v2.md). Regras do projeto: [CLAUDE.md](CLAUDE.md).

## Estrutura

| Pasta | Conteúdo |
|---|---|
| [frontend/](frontend/) | Cliente desktop Windows (Electron + React + TypeScript) |
| [backend/](backend/) | API em Go (identidade, convites, canais, tokens LiveKit, presença, menções) |
| [infra/](infra/) | LiveKit, Caddy, Docker Compose e scripts do servidor |
| [contracts/](contracts/) | `openapi.yaml`, contrato único entre frontend e backend |
| [docs/](docs/) | Plano, arquitetura, protocolos e guia do servidor |

A v1 (backend Node + Electron + chat) está preservada na tag `v1-node`.

## Pré-requisitos

- Windows, Node.js 22+ e npm
- PowerShell 7 (`pwsh`), usado pelos scripts do backend e pelo aceite do frontend
- Docker Desktop (o backend em Go compila, testa e passa por lint **em contêiner**: não é preciso instalar Go, gcc nem golangci-lint)

## Início rápido

```powershell
# Servidor de desenvolvimento (LiveKit + backend)
cd infra
docker compose up -d --build
docker compose exec backend /server seed

# Frontend (na primeira execução o app pede o endereço do servidor: http://localhost:8080)
cd ..\frontend
npm install
npm run typecheck; npm run lint; npm run build
npm run dev
npm run e2e          # aceite com duas instâncias reais do app

# Backend (tudo via Docker)
cd ..\backend
pwsh -NoProfile -File scripts\check.ps1   # generate, build, vet, test -race, lint
pwsh -NoProfile -File scripts\e2e.ps1     # aceite com backend e LiveKit reais
```

Detalhes de cada parte estão no README da respectiva pasta.

## Estado

Fases R0 (reestruturação), R1a (backend Go: identidade, canais e tokens LiveKit), R1b (tempo real: webhooks do LiveKit, presença, WebSocket e menções) e R2 (frontend conectado ao backend Go: tipos gerados do contrato, endereço do servidor na tela, presença e "chamar atenção" pelo WebSocket, notificação do Windows e bandeja) concluídas. Próxima: R3 (servidor caseiro com Caddy e TLS).
