# infra

LiveKit Server (SFU de mídia) e, a partir da fase R3, Caddy (TLS), Compose de produção e scripts para o servidor Ubuntu LTS.

Hoje contém apenas o ambiente local de desenvolvimento, herdado da v1:

```powershell
Copy-Item .env.example .env   # preencha LIVEKIT_API_KEY e LIVEKIT_API_SECRET (32+ caracteres)
docker compose up -d
docker compose logs -f
docker compose down
```

Portas: 7880 (sinalização), 7881/TCP (reserva), 7882/UDP (mídia).

- `docker-compose.yml`: serviço `livekit`
- `livekit.yaml`: configuração do LiveKit
