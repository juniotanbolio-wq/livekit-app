# backend

API em Go (`net/http` da biblioteca padrão): identidade (convites, cadastro, login), canais de voz, emissão de tokens LiveKit e **tempo real**: presença (quem está em cada canal e quem está transmitindo, alimentada pelos webhooks do LiveKit) e menções, entregues por WebSocket. Protocolo: [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).

O contrato é [../contracts/openapi.yaml](../contracts/openapi.yaml); o servidor e as consultas SQL são **gerados** a partir dele (veja "Código gerado").

## Como rodar (sem Go, gcc nem golangci-lint no Windows)

Esta máquina não tem Go, gcc nem golangci-lint, e nada disso precisa ser instalado: todos os comandos rodam em contêiner pelos scripts de [scripts/](scripts/). Pré-requisito: Docker Desktop aberto.

Rode a partir de `backend/`, no **PowerShell 7** (`pwsh`; os scripts exigem 7.0+ com `#Requires`):

```powershell
pwsh -NoProfile -File scripts\check.ps1     # tudo: generate, build, vet, test -race, lint
pwsh -NoProfile -File scripts\e2e.ps1       # aceite ponta a ponta (backend e LiveKit reais)
```

| Script | O que faz |
|---|---|
| `scripts\check.ps1` | Roda `generate` (e falha se o código gerado commitado estiver desatualizado), `go build`, `go vet`, `go test -race` e `golangci-lint`. Mostra o resumo no fim. |
| `scripts\test.ps1 [args]` | `go test -race -count=1 ./...` na imagem `golang:1.27` (Debian, já traz o gcc que o `-race` exige). Argumentos vão ao `go test`: `scripts\test.ps1 -run TestRegister ./internal/httpapi`. |
| `scripts\lint.ps1 [args]` | `golangci-lint run ./...` na imagem oficial `golangci/golangci-lint` (versão fixada em `scripts\_docker.ps1`). Configuração em `.golangci.yml`. |
| `scripts\generate.ps1` | `go generate ./...`: `oapi-codegen` e `sqlc` (versões fixadas nas diretivas `//go:generate`). |
| `scripts\go.ps1 <args>` | Qualquer comando `go` no contêiner: `scripts\go.ps1 mod tidy`, `scripts\go.ps1 build ./...`. |
| `scripts\e2e.ps1` | Aceite das fases R1a e R1b (veja abaixo). |

Todos devolvem código de saída diferente de zero em caso de falha. Os caches de módulos e de build ficam em volumes Docker (`livekit-go-mod`, `livekit-go-build`, `livekit-lint-cache`) para as execuções seguintes serem rápidas; para limpar: `docker volume rm livekit-go-mod livekit-go-build livekit-lint-cache`.

### Aceite ponta a ponta (`e2e.ps1`)

Constrói a imagem de produção do backend e o bot de teste, sobe o LiveKit (mesma imagem do `infra/docker-compose.yml`) e o backend em contêineres descartáveis, numa rede Docker própria (portas só em 127.0.0.1: LiveKit 17880, backend 18080), e percorre:

- **R1a (identidade)**: `seed` → `invite create` → cadastro → convite reutilizado (recusado) → login → canais → token LiveKit `voice` e `spectator`. Cada token é conferido por dentro (identidade, `hidden`, `canPublish`) e **validado pelo próprio LiveKit** em `GET /rtc/validate`, com um token adulterado como controle negativo.
- **R1b (tempo real)**: participantes de verdade (o bot `cmd/e2ebot`, feito com a `server-sdk-go`, entra nas salas com tokens emitidos pelo backend e publica uma trilha de tela) disparam **webhooks reais** do LiveKit, e o teste confere pelo WebSocket: assinatura dos webhooks (inclusive recusas), autenticação do WebSocket (sem token na URL), snapshot inicial, `participant_joined`/`stream_started`/`stream_stopped`/`participant_left` com `seq` contíguo, espectador oculto fora da presença, menções (entrega, offline, inexistente, limites por remetente e por destinatário), limite de conexões por usuário, encerramento com 1001 e as duas reconciliações: **ao iniciar** (reinicia o backend com uma pessoa transmitindo) e **periódica** (corta a rede entre LiveKit e backend para o webhook de saída se perder de verdade, e confere que a reconciliação corrige e avisa os clientes). Leva alguns minutos (há uma espera real de ~40 s para os webhooks se perderem).

Não usa o seu `infra/.env` nem as suas portas de desenvolvimento, e remove tudo no final (contêineres, rede, volume e arquivos temporários). `/rtc/validate` confere assinatura e permissões do token, não a conectividade de mídia (isso é o aceite da R2); o bot, porém, estabelece mídia WebRTC de verdade com o LiveKit.

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
| `GET /health` | não | Vivo (não toca em banco nem LiveKit) → `{status: "ok", livekitUrl}`. O cliente o usa para validar o endereço do servidor e descobrir o LiveKit público antes do login |
| `POST /api/auth/register` | não | Cadastro com convite → `201 {token, user}` |
| `POST /api/auth/login` | não | Login → `200 {token, user}` |
| `GET /api/channels` | Bearer | Os 7 canais de voz, em ordem |
| `POST /api/livekit/token` | Bearer | `{channelId, role: voice\|spectator}` → `{token, url, roomName}` |
| `GET /ws` | 1ª mensagem `auth` | WebSocket de presença e menções (o token **não** vai na URL). Ver o [protocolo](../docs/protocolo-tempo-real.md) |
| `POST /webhooks/livekit` | assinatura do LiveKit | Webhooks do LiveKit (chamado só pelo LiveKit, pela rede interna) |

`/ws` e `/webhooks/livekit` ficam fora do OpenAPI (o gerador não modela WebSocket), mas as mensagens do WebSocket estão em `components/schemas` (`Ws*`) do contrato, para os tipos do cliente saírem do mesmo lugar.

Erros sempre no formato `{"error": "mensagem", "details": ...}`. Rotas de autenticação têm rate limit por IP (compartilhado entre cadastro e login); excedido → `429` com `Retry-After`.

Permissões do token LiveKit (as mesmas da v1): `voice` publica, envia dados e assina; `spectator` é oculto (`hidden`), não publica nem envia dados, só assina, e usa a identidade `<id>#spectator`. A sala de cada canal é `channel-<id>`.

## Variáveis de ambiente

Todas descritas em [.env.example](.env.example). Obrigatórias: `JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (segredos com 32+ caracteres). O servidor valida tudo ao iniciar e lista todos os erros de uma vez.

Tempo real (R1b): `LIVEKIT_URL` (endereço HTTP que o backend usa para falar com o LiveKit; o padrão deriva de `LIVEKIT_PUBLIC_URL`), `RECONCILE_INTERVAL`, `WS_AUTH_TIMEOUT`, `WS_PING_INTERVAL`, `WS_MAX_CONNS_PER_USER`, `WS_MAX_CONNS`, `MENTION_SENDER_LIMIT`, `MENTION_RECIPIENT_LIMIT`, `MENTION_WINDOW`. Padrões e significado em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).

O LiveKit precisa saber para onde mandar os webhooks e com qual chave assiná-los: seção `webhook` do `livekit.yaml` (veja [../infra/README.md](../infra/README.md)). A chave (`api_key`) tem de ser a mesma `LIVEKIT_API_KEY` do backend.

## Imagem de produção

```powershell
docker build -t livekit-backend .
docker run --rm -p 8080:8080 -v livekit-data:/data --env-file .env livekit-backend
```

Binário estático sem cgo (SQLite em Go puro), imagem `distroless` com usuário não-root, banco em `/data` (use um volume).

## Estrutura

- `cmd/server/`: ponto de entrada e subcomandos
- `cmd/e2ebot/`: participante de teste do LiveKit, usado só pelo `scripts\e2e.ps1` (não entra na imagem)
- `internal/config/`: leitura e validação do ambiente
- `internal/db/`: abertura do SQLite, migrações (goose, embutidas) e consultas SQL
- `internal/store/`: código gerado pelo sqlc
- `internal/api/`: servidor gerado pelo oapi-codegen
- `internal/httpapi/`: handlers, middlewares (CORS, limite de corpo, rate limit, autenticação) e montagem do roteador
- `internal/service/`: regras de negócio (convites, cadastro, login, canais, seed)
- `internal/auth/`: senhas (argon2id) e JWT de sessão
- `internal/livekit/`: emissão de tokens e permissões por papel; receptor de webhooks e reconciliação com o RoomService
- `internal/presence/`: presença em memória (quem está em cada canal e quem transmite), com sequência e inscrições
- `internal/realtime/`: hub de conexões WebSocket (autenticação, snapshot, ping/pong, limites) e menções
- `internal/ratelimit/`: limitador por IP em janela fixa
- `internal/testutil/`: apoio aos testes
- `scripts/`: scripts Docker (PowerShell 7)
