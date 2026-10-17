# backend

API em Go (`net/http` da biblioteca padrão): identidade (convites, cadastro, login), canais de voz e emissão de tokens LiveKit. Presença em tempo real e menções chegam na R1b.

O contrato é [../contracts/openapi.yaml](../contracts/openapi.yaml); o servidor e as consultas SQL são **gerados** a partir dele (veja "Código gerado").

## Como rodar (sem Go, gcc nem golangci-lint no Windows)

Esta máquina não tem Go, gcc nem golangci-lint, e nada disso precisa ser instalado: todos os comandos rodam em contêiner pelos scripts de [scripts/](scripts/). Pré-requisito: Docker Desktop aberto.

Rode a partir de `backend/`. O prefixo `-ExecutionPolicy Bypass` vale só para aquela execução e evita mudar a política do PowerShell da máquina:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check.ps1     # tudo: generate, build, vet, test -race, lint
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1       # aceite ponta a ponta (backend e LiveKit reais)
```

| Script | O que faz |
|---|---|
| `scripts\check.ps1` | Roda `generate` (e falha se o código gerado commitado estiver desatualizado), `go build`, `go vet`, `go test -race` e `golangci-lint`. Mostra o resumo no fim. |
| `scripts\test.ps1 [args]` | `go test -race -count=1 ./...` na imagem `golang:1.27` (Debian, já traz o gcc que o `-race` exige). Argumentos vão ao `go test`: `scripts\test.ps1 -run TestRegister ./internal/httpapi`. |
| `scripts\lint.ps1 [args]` | `golangci-lint run ./...` na imagem oficial `golangci/golangci-lint` (versão fixada em `scripts\_docker.ps1`). Configuração em `.golangci.yml`. |
| `scripts\generate.ps1` | `go generate ./...`: `oapi-codegen` e `sqlc` (versões fixadas nas diretivas `//go:generate`). |
| `scripts\go.ps1 <args>` | Qualquer comando `go` no contêiner: `scripts\go.ps1 mod tidy`, `scripts\go.ps1 build ./...`. |
| `scripts\e2e.ps1` | Aceite da R1a (veja abaixo). |

Todos devolvem código de saída diferente de zero em caso de falha. Os caches de módulos e de build ficam em volumes Docker (`livekit-go-mod`, `livekit-go-build`, `livekit-lint-cache`) para as execuções seguintes serem rápidas; para limpar: `docker volume rm livekit-go-mod livekit-go-build livekit-lint-cache`.

### Aceite ponta a ponta (`e2e.ps1`)

Constrói a imagem de produção do backend, sobe o LiveKit (mesma imagem do `infra/docker-compose.yml`) e o backend em contêineres descartáveis (portas só em 127.0.0.1: LiveKit 17880, backend 18080), e percorre: `seed` → `invite create` → cadastro → convite reutilizado (recusado) → login → canais → token LiveKit `voice` e `spectator`. Cada token é conferido por dentro (identidade, `hidden`, `canPublish`) e **validado pelo próprio LiveKit** em `GET /rtc/validate`, com um token adulterado como controle negativo. Não usa o seu `infra/.env` nem as suas portas de desenvolvimento, e remove tudo no final.

`/rtc/validate` confere assinatura e permissões do token, não a conectividade de mídia (isso é o aceite da R2).

## Código gerado

`internal/api/api.gen.go` (oapi-codegen) e `internal/store/*.go` (sqlc) são commitados, então o build não depende das ferramentas. Para mudar uma rota ou uma consulta:

1. Edite `contracts/openapi.yaml`, `internal/db/queries/*.sql` ou `internal/db/migrations/*.sql`.
2. Rode `scripts\generate.ps1` e commite o resultado. O `check.ps1` falha se você esquecer.

Atenção: **não use acentos em `internal/db/queries/*.sql`** (nem em comentários). O sqlc calcula deslocamentos em bytes para o engine SQLite e corrompe o texto da consulta com caracteres de vários bytes.

## Comandos do binário

```text
server [serve]                      sobe a API HTTP (padrão; aplica as migrações ao iniciar)
server seed                         garante os 7 canais de voz (voice-1..voice-7) e o admin; idempotente
server invite create [--hours N]    cria convite de uso único e imprime o código (só o hash fica no banco)
```

Com o contêiner de produção rodando: `docker exec <contêiner> /server invite create --hours 24`.

`seed` usa `SEED_ADMIN_USERNAME` e `SEED_ADMIN_PASSWORD`. Se o admin já existe, mantém a senha atual (rodar de novo nunca troca senha de ninguém).

## Endpoints

| Rota | Auth | Descrição |
|---|---|---|
| `GET /health` | não | Vivo (não toca em banco nem LiveKit) |
| `POST /api/auth/register` | não | Cadastro com convite → `201 {token, user}` |
| `POST /api/auth/login` | não | Login → `200 {token, user}` |
| `GET /api/channels` | Bearer | Os 7 canais de voz, em ordem |
| `POST /api/livekit/token` | Bearer | `{channelId, role: voice\|spectator}` → `{token, url, roomName}` |

Erros sempre no formato `{"error": "mensagem", "details": ...}`. Rotas de autenticação têm rate limit por IP (compartilhado entre cadastro e login); excedido → `429` com `Retry-After`.

Permissões do token LiveKit (as mesmas da v1): `voice` publica, envia dados e assina; `spectator` é oculto (`hidden`), não publica nem envia dados, só assina, e usa a identidade `<id>#spectator`. A sala de cada canal é `channel-<id>`.

## Variáveis de ambiente

Todas descritas em [.env.example](.env.example). Obrigatórias: `JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (segredos com 32+ caracteres). O servidor valida tudo ao iniciar e lista todos os erros de uma vez.

## Imagem de produção

```powershell
docker build -t livekit-backend .
docker run --rm -p 8080:8080 -v livekit-data:/data --env-file .env livekit-backend
```

Binário estático sem cgo (SQLite em Go puro), imagem `distroless` com usuário não-root, banco em `/data` (use um volume).

## Estrutura

- `cmd/server/`: ponto de entrada e subcomandos
- `internal/config/`: leitura e validação do ambiente
- `internal/db/`: abertura do SQLite, migrações (goose, embutidas) e consultas SQL
- `internal/store/`: código gerado pelo sqlc
- `internal/api/`: servidor gerado pelo oapi-codegen
- `internal/httpapi/`: handlers, middlewares (CORS, limite de corpo, rate limit, autenticação) e montagem do roteador
- `internal/service/`: regras de negócio (convites, cadastro, login, canais, seed)
- `internal/auth/`: senhas (argon2id) e JWT de sessão
- `internal/livekit/`: emissão de tokens e permissões por papel
- `internal/ratelimit/`: limitador por IP em janela fixa
- `internal/testutil/`: apoio aos testes
- `scripts/`: scripts Docker (PowerShell)
