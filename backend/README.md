# backend

API em Go (`net/http` da biblioteca padrão). Nesta fase (R0) é só o esqueleto: configuração por variáveis de ambiente, `GET /health`, logs `slog` em JSON, shutdown gracioso e Dockerfile.

## Comandos

```powershell
go build ./...
go vet ./...
go test ./...                 # no Windows sem gcc, `-race` não roda localmente (veja abaixo)
golangci-lint run             # configuração em .golangci.yml
go run ./cmd/server           # sobe em :8080
curl http://localhost:8080/health
```

`go test -race` exige cgo. Sem compilador C no Windows, rode via Docker:

```powershell
docker run --rm -v "${PWD}:/src" -w /src golang:1.27 go test -race ./...
```

Imagem de produção:

```powershell
docker build -t livekit-backend .
docker run --rm -p 8080:8080 livekit-backend
```

## Variáveis de ambiente

Veja [.env.example](.env.example): `HTTP_ADDR`, `LOG_LEVEL`, `DATABASE_PATH`.

## Estrutura

- `cmd/server/`: ponto de entrada
- `internal/config/`: leitura e validação do ambiente
- `internal/httpapi/`: roteador HTTP
