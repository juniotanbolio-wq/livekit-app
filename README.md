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

Em outro terminal, abra o app desktop:

```powershell
npm run dev:desktop
```

Para testar com dois usuários no mesmo PC, com o `dev:desktop` rodando, abra uma segunda janela com perfil separado:

```powershell
npm run dev:second
```

O app usa `http://localhost:3000` por padrão. Para apontar para outro server, defina a variável antes de abrir:

```powershell
$env:LIVEKIT_APP_SERVER_URL = "http://192.168.0.10:3000"
$env:LIVEKIT_APP_LIVEKIT_URL = "ws://192.168.0.10:7880"
npm run dev:desktop
```

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
| GET    | `/api/presence`              | sim  | Quem está em cada canal de voz → `{ channels: [{ channelId, participants }] }`            |

As rotas de auth têm rate limit de 10 requisições a cada 15 minutos por IP.

O Socket.IO fica no mesmo endereço do server e se conecta com `auth: { token }`:

- Para enviar, o cliente emite `message:send` com `{ channelId, content }` e recebe um ack `{ ok, data | error }`.
- Toda mensagem nova é entregue no evento `message:new`.

## Scripts

Na raiz: `dev`, `dev:desktop`, `dev:second`, `build`, `typecheck`, `lint`, `format`, `db:migrate`, `db:seed`, `invite:create`, `infra:up`, `infra:down` e `infra:logs`.

## Checklist de teste manual

Antes de começar: LiveKit no ar, `npm run dev` e `npm run dev:desktop` rodando, e dois convites criados com `npm run invite:create`.

**Cadastro**

- [ ] Clicar em "Cadastrar" com os campos vazios mostra o erro de cada campo
- [ ] Um código de convite errado mostra "Código de convite inválido, expirado ou já utilizado"
- [ ] Senhas diferentes mostram "As senhas não conferem"
- [ ] Um convite válido cadastra e abre o app no `#geral`
- [ ] Reusar o mesmo convite em outra conta mostra erro

**Login**

- [ ] Uma senha errada mostra "Usuário ou senha incorretos"
- [ ] O login correto abre o app
- [ ] Fechar e reabrir a janela entra direto, sem pedir senha
- [ ] "Sair da conta" volta para o login, e ao reabrir o app ele pede login de novo

**Chat entre duas instâncias** (rode `npm run dev:second` e entre com o segundo usuário)

- [ ] Uma mensagem enviada com Enter aparece na outra janela na hora
- [ ] Shift+Enter quebra linha sem enviar
- [ ] Rolar para cima carrega o histórico antigo sem pular a posição
- [ ] Rolado para cima, uma mensagem nova não puxa a tela para baixo
- [ ] No fim da lista, uma mensagem nova rola automaticamente
- [ ] Acima de 1800 caracteres aparece o contador; acima de 2000, o envio é bloqueado

**Voz entre duas instâncias**

- [ ] Clicar em "Voz 1" nas duas janelas: as duas entram, cada uma se ouve na outra e a grade mostra 2 participantes
- [ ] Quem fala ganha borda verde na grade e no avatar da sidebar
- [ ] Mutar o microfone mostra o ícone de mudo na outra janela
- [ ] "Silenciar áudio" deixa de tocar os outros e muta o próprio microfone; desfazer restaura o estado anterior
- [ ] Ligar a câmera faz o vídeo aparecer na outra janela
- [ ] A outra janela, sem entrar no canal, vê os nomes na sidebar em até 5 segundos
- [ ] Ir para `#geral` durante a chamada mantém a voz e o indicador "Voz conectada"; clicar nele volta para a grade
- [ ] Trocar de "Voz 1" para "Voz 2" sai de um e entra no outro

**Troca de dispositivos** (engrenagem no painel do usuário)

- [ ] As listas de microfone, saída e câmera aparecem com nomes reais
- [ ] Trocar o microfone durante a chamada passa a usar o novo, sem cair
- [ ] Trocar a saída de áudio passa a tocar no novo dispositivo
- [ ] Trocar a câmera com ela ligada troca o vídeo
- [ ] A escolha continua salva ao reabrir o app

**Reconexão**

- [ ] Derrubar o server (Ctrl+C no `npm run dev`) mostra "Reconectando..." no chat e preserva o texto digitado
- [ ] Ao subir o server de novo, o chat volta sozinho e mensagens novas chegam
- [ ] `docker compose restart livekit` mostra "Reconectando..." na voz e depois volta para "Voz conectada"
- [ ] `docker compose stop livekit` faz aparecer o aviso de conexão de voz perdida, sem travar o app
