# infra

LiveKit Server (SFU de mídia) e, a partir da fase R3, Caddy (TLS), Compose de produção e scripts para o servidor Ubuntu LTS.

Hoje contém apenas o ambiente local de desenvolvimento (LiveKit + backend):

```powershell
Copy-Item .env.example .env   # preencha LIVEKIT_API_SECRET e JWT_SECRET (32+ caracteres cada)
docker compose up -d --build
docker compose exec backend /server seed             # 7 canais + admin (usa SEED_ADMIN_*)
docker compose exec backend /server invite create    # código de convite de uso único
docker compose logs -f
docker compose down
```

Portas: 7880 (sinalização do LiveKit), 7881/TCP (reserva), 7882/UDP (mídia) e 8080 (backend, só em 127.0.0.1).

- `docker-compose.yml`: serviços `livekit` e `backend` (build de `../backend`, banco SQLite no volume `backend-data`)
- `livekit.yaml`: configuração do LiveKit, incluindo o **webhook** que avisa o backend (presença e quem está transmitindo)

## Como o LiveKit fala com o backend

O LiveKit chama `http://backend:8080/webhooks/livekit` (nome do serviço na rede interna do Compose) assinando cada evento com a chave de API. Por isso:

- No desenvolvimento a chave de API tem nome **fixo `devkey`**: o `docker-compose.yml` a define em `LIVEKIT_KEYS` (com o segredo `LIVEKIT_API_SECRET` do `.env`) e no backend, e o `livekit.yaml` a cita em `webhook.api_key`. Os três precisam coincidir; se mudar o nome, mude nos três lugares. (A variável `LIVEKIT_API_KEY` de um `.env` antigo é ignorada.)
- O backend fala com o LiveKit pela rede interna (`LIVEKIT_URL=http://livekit:7880`, para a reconciliação via RoomService), mas devolve ao cliente o endereço público (`LIVEKIT_PUBLIC_URL`, `ws://localhost:7880`).
- Se o backend ficar fora do ar, o LiveKit desiste de cada webhook depois de ~25 s; ao voltar, o backend reconstrói a presença consultando o LiveKit. Detalhes em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).
- O `backend\scripts\e2e.ps1` não usa este Compose: sobe contêineres próprios e descartáveis, com uma cópia temporária do `livekit.yaml` (outro nome de chave e de host).
