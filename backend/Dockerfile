# Estágio de build: binário estático (sem cgo; o SQLite é o modernc, em Go puro), por isso a imagem final pode ser mínima.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server
# A imagem final não tem shell nem mkdir: o diretório de dados é criado aqui e copiado com o dono certo.
RUN mkdir /data

# Estágio final: sem shell, sem gerenciador de pacotes, usuário não-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
# Banco SQLite em volume: sem ele os dados somem quando o contêiner é recriado.
COPY --from=build --chown=nonroot:nonroot /data /data
ENV DATABASE_PATH=/data/app.db
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
# Subcomandos (`seed`, `invite create`) rodam com `docker exec <contêiner> /server <comando>`.
ENTRYPOINT ["/server"]
