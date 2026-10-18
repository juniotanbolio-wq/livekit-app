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

## Iniciar teste (duas instâncias no mesmo PC)

Atalho na área de trabalho, criado uma vez com:

```powershell
pwsh -NoProfile -File infra\scripts\criar-atalho.ps1
```

O atalho "Iniciar teste" (ou `pwsh -NoProfile -File infra\scripts\iniciar-teste.ps1`):

1. confere o Docker e abre o Docker Desktop se precisar;
2. sobe o Compose de desenvolvimento (LiveKit + backend) e espera o backend responder;
3. roda o `seed`;
4. abre **duas instâncias** do app empacotado (`frontend\dist\win-unpacked`, gerado com `npm run package` se ainda não existir). A segunda tem perfil próprio, com sessão e dispositivos separados.

Na primeira vez, cada instância pede o servidor (`http://localhost:8080`, já preenchido) e o login.

| Opção | Efeito |
|---|---|
| `-Convites 2` | gera e mostra dois convites de uso único |
| `-Rebuild` | recompila o backend e o app |

Precisa de `infra\.env` (veja [infra/README.md](infra/README.md)) e de `npm install` feito uma vez em `frontend\`.

O `.exe` portátil, que roda sem instalar, fica em `frontend\dist\LiveKitApp-<versão>-portatil.exe`. O endereço do servidor é configurável na tela. Assinatura, ícone e instalador ficam para a R4.

## Estado

Concluídas:
- **R0**: reestruturação.
- **R1a**: backend Go (identidade, canais e tokens LiveKit).
- **R1b**: tempo real (webhooks do LiveKit, presença, WebSocket e menções).
- **R2**: frontend conectado ao backend Go.
- **Fase A**: auditoria.
- **Fase Q**: qualidade de áudio e vídeo (codificação por GPU, camada máxima para quem assiste, "Assistir" sob demanda, RNNoise e noise gate, executável de teste). Medições em [docs/medicoes.md](docs/medicoes.md).

Próxima: R3 (servidor caseiro com Caddy e TLS).
