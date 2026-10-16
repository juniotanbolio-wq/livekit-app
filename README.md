# LiveKit App

App desktop de comunicação em tempo real para um grupo fechado: 1 canal de texto e 7 canais de voz/vídeo, usando LiveKit.

## Requisitos

- Windows com Node.js 22 ou mais recente e npm 11
- Docker Desktop iniciado

## Rodar no Windows (PowerShell)

Na raiz do projeto:

```powershell
npm install
Copy-Item infra\.env.example infra\.env
Copy-Item apps\server\.env.example apps\server\.env
```

Edite os dois `.env`:

- Use o mesmo `LIVEKIT_API_KEY` e o mesmo `LIVEKIT_API_SECRET` nos dois arquivos. O segredo precisa de 32 ou mais caracteres.
- Em `apps\server\.env`, defina também `JWT_SECRET` (32 ou mais caracteres) e `SEED_ADMIN_PASSWORD`.

Para gerar segredos aleatórios:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Suba o LiveKit:

```powershell
cd infra
docker compose up -d
cd ..
```

Prepare o banco e suba o server:

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

O server fica em `http://localhost:3000` e o LiveKit em `ws://localhost:7880`.

## Convites

```powershell
npm run invite:create
npm run invite:create -- --hours 24
```

Cada código vale para um único cadastro. A validade padrão vem de `INVITE_TTL_HOURS`.

## Testar com curl

Use `curl.exe`, porque no PowerShell `curl` é um alias de outro comando. Substitua `<CODIGO>`, `<TOKEN>` e `<ID_CANAL_VOZ>`.

```powershell
curl.exe -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{\"inviteCode\":\"<CODIGO>\",\"username\":\"maria\",\"password\":\"senhasegura1\"}'
curl.exe -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{\"username\":\"maria\",\"password\":\"senhasegura1\"}'
curl.exe http://localhost:3000/api/channels -H "Authorization: Bearer <TOKEN>"
curl.exe -X POST http://localhost:3000/api/livekit/token -H "Content-Type: application/json" -H "Authorization: Bearer <TOKEN>" -d '{\"channelId\":\"<ID_CANAL_VOZ>\",\"role\":\"voice\"}'
curl.exe "http://localhost:3000/api/channels/<ID_CANAL_TEXTO>/messages?limit=50" -H "Authorization: Bearer <TOKEN>"
```

## API

| Método | Rota                         | Auth | Descrição                                                                                 |
| ------ | ---------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| GET    | `/health`                    | não  | Status do server                                                                          |
| POST   | `/api/auth/register`         | não  | `{ inviteCode, username, password }` → `{ token, user }`                                  |
| POST   | `/api/auth/login`            | não  | `{ username, password }` → `{ token, user }`                                              |
| GET    | `/api/channels`              | sim  | Lista os canais                                                                           |
| GET    | `/api/channels/:id/messages` | sim  | `?before=<id>&limit=1..100`, do mais novo para o mais antigo → `{ messages, nextCursor }` |
| POST   | `/api/livekit/token`         | sim  | `{ channelId, role: "voice" \| "spectator" }` → `{ token, url, roomName }`                |

As rotas de auth têm rate limit de 10 requisições a cada 15 minutos por IP.

O Socket.IO fica no mesmo endereço do server e se conecta com `auth: { token }`:

- Para enviar, o cliente emite `message:send` com `{ channelId, content }` e recebe um ack `{ ok, data | error }`.
- Toda mensagem nova é entregue no evento `message:new`.

## Scripts

Na raiz: `dev`, `dev:desktop`, `build`, `typecheck`, `lint`, `format`, `db:migrate`, `db:seed`, `invite:create`, `infra:up`, `infra:down` e `infra:logs`.
