# infra

LiveKit Server (SFU de mídia) e, a partir da fase R3, Caddy (TLS), Compose de produção e scripts para o servidor Ubuntu LTS.

Hoje contém apenas o ambiente local de desenvolvimento (LiveKit + backend):

```powershell
Copy-Item .env.example .env   # preencha LIVEKIT_API_SECRET, JWT_SECRET (32+ caracteres cada) e SEED_ADMIN_PASSWORD
docker compose up -d --build
docker compose exec backend /server seed             # 7 canais + admin (usa SEED_ADMIN_*)
docker compose exec backend /server invite create    # código de convite de uso único
docker compose logs -f
docker compose down
```

Portas: 7880 (sinalização do LiveKit), 7881/TCP (reserva), 7882/UDP (mídia) e 8080 (backend, só em 127.0.0.1). No app, o endereço do servidor é `http://localhost:8080` (pré-preenchido na primeira execução em desenvolvimento).

O backend aceita as origens de navegador do Vite (`http://localhost:5173`, `http://127.0.0.1:5173`) e do app compilado (`app://desktop`); para mudar, defina `CORS_ORIGINS` no `.env`. Os aceites (`frontend\scripts\e2e.mjs` e `backend\scripts\e2e.ps1`) **não** usam este Compose: sobem contêineres, rede e volume próprios e descartáveis.

- `docker-compose.yml`: serviços `livekit` e `backend` (build de `../backend`, banco SQLite no volume `backend-data`)
- `livekit.yaml`: configuração do LiveKit, incluindo o **webhook** que avisa o backend (presença e quem está transmitindo)
- `scripts/iniciar-teste.ps1`: confere o Docker (abre o Docker Desktop se precisar), sobe este Compose, espera o `/health`, roda o `seed` e abre duas instâncias do app empacotado (a segunda com perfil próprio em `%LOCALAPPDATA%\LiveKitApp-teste\B`). Opções `-Rebuild`, `-Convites N` e `-Pausar`.
- `scripts/criar-atalho.ps1`: cria o atalho "Iniciar teste" na área de trabalho

## Camadas de vídeo e rede de quem assiste

O SFU repassa a camada mais alta que o espectador pede (o app pede sempre a máxima). Ele só desce de camada se a estimativa de banda **daquele espectador** não comporta. Em H.264/VP8 desce de 1080p60 para 720p30 e 360p15; em AV1/VP9 (SVC L1T3) cai o fps (60 → 30 → 15) e a resolução fica. Ao melhorar a rede, ele volta a subir sozinho. Isso é o controle de congestionamento padrão do LiveKit (`rtc.congestion_control`, ligado por padrão, sem pausar o vídeo); não há configuração nossa no `livekit.yaml`. Do lado de quem transmite, o WebRTC só desliga a camada mais alta se o upload de casa não comportar.

## Como o LiveKit fala com o backend

O LiveKit chama `http://backend:8080/webhooks/livekit` (nome do serviço na rede interna do Compose) assinando cada evento com a chave de API. Por isso:

- No desenvolvimento a chave de API tem nome **fixo `devkey`**: o `docker-compose.yml` a define em `LIVEKIT_KEYS` (com o segredo `LIVEKIT_API_SECRET` do `.env`) e no backend, e o `livekit.yaml` a cita em `webhook.api_key`. Os três precisam coincidir; se mudar o nome, mude nos três lugares. (A variável `LIVEKIT_API_KEY` de um `.env` antigo é ignorada.)
- O backend fala com o LiveKit pela rede interna (`LIVEKIT_URL=http://livekit:7880`, para a reconciliação via RoomService), mas devolve ao cliente o endereço público (`LIVEKIT_PUBLIC_URL`, `ws://localhost:7880`).
- Se o backend ficar fora do ar, o LiveKit desiste de cada webhook depois de ~25 s; ao voltar, o backend reconstrói a presença consultando o LiveKit. Detalhes em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).
- O `backend\scripts\e2e.ps1` não usa este Compose: sobe contêineres próprios e descartáveis, com uma cópia temporária do `livekit.yaml` (outro nome de chave e de host).
