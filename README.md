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
- Go (versão estável atual)
- Docker Desktop

## Início rápido

```powershell
# Frontend
cd frontend
npm install
npm run typecheck; npm run lint; npm run build

# Backend
cd ..\backend
go build ./...; go vet ./...; go test ./...
```

Detalhes de cada parte estão no README da respectiva pasta.

## Estado

Fase R0 (reestruturação) concluída. O app fica sem backend funcional até a fase R2.
