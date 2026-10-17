# Protocolo de tempo real (WebSocket e webhooks)

Como o backend sabe quem está em cada canal de voz e quem está transmitindo, e como entrega isso (e as menções) aos clientes. Implementado na fase R1b em `backend/internal/{presence,livekit,realtime}`.

```
[LiveKit] --webhooks assinados--> POST /webhooks/livekit --> [presença em memória] --> [WebSocket /ws] --> clientes
     ^                                                              ^
     '------ RoomService (ao iniciar e a cada 60 s) ----------------'   (reconciliação: cobre webhooks perdidos)
```

O backend nunca toca na mídia. A presença não é guardada em banco: é reconstruída do LiveKit ao iniciar.

## 1. Webhooks do LiveKit — `POST /webhooks/livekit`

- O LiveKit assina cada webhook com um JWT (HS256) no cabeçalho `Authorization`, com o SHA-256 do corpo. O backend confere assinatura, expiração e hash com a mesma chave/segredo de API usados nos tokens. Qualquer falha → `401` sem detalhes. Só `POST` (`405` nos demais); corpo limitado a 256 KiB.
- Configuração no LiveKit (`infra/livekit.yaml`): seção `webhook` com `api_key` (o **nome** de uma das chaves em `LIVEKIT_KEYS`) e `urls`.
- Eventos tratados (os demais são ignorados com `200`):

| Evento do LiveKit | Efeito |
|---|---|
| `participant_joined` | entra na presença do canal |
| `participant_left` | sai da presença (e encerra a transmissão dele) |
| `track_published` com `source = SCREEN_SHARE` | começa a transmitir |
| `track_unpublished` com `source = SCREEN_SHARE` | para de transmitir |
| `room_finished` | esvazia o canal |

- Só salas `channel-<id>` contam. Câmera e microfone não são "transmissão".
- **Ficam fora da presença**: participantes `hidden` e identidades terminadas em `#spectator` (o Modo Espectador é uma segunda conexão do mesmo usuário, não uma pessoa a mais).
- Os eventos são idempotentes e identificam a conexão pelo `sid` do participante. Um `participant_left` atrasado de uma conexão antiga não derruba a conexão nova do mesmo usuário; um `participant_joined` que chega depois do `left` da mesma conexão é descartado (lápide de 2 min).

## 2. Reconciliação

Webhooks podem se perder (backend fora do ar, rede). Por isso o backend consulta o `RoomService` (`ListRooms` + `ListParticipants`) ao iniciar e a cada `RECONCILE_INTERVAL` (60 s) e aplica a **diferença** ao estado em memória, emitindo para os clientes os mesmos eventos que os webhooks teriam emitido. Quando a reconciliação muda algo, registra `reconciliacao corrigiu a presenca` com `mudancas`.

- Se qualquer consulta falhar, **nada** é aplicado (uma listagem parcial pareceria "essas pessoas saíram").
- O que um webhook mudou depois do início da consulta não é desfeito por ela (a observação seria mais antiga que o webhook).
- LiveKit fora do ar ao iniciar não derruba o backend: a próxima rodada tenta de novo.

## 3. WebSocket — `GET /ws`

### Conexão e autenticação

1. O cliente abre `ws(s)://servidor/ws` **sem credenciais na URL** (URLs vazam em logs de acesso, de proxy e no histórico; o token de sessão vale por dias).
2. Em até `WS_AUTH_TIMEOUT` (5 s) o cliente envia a primeira mensagem: `{"type":"auth","token":"<JWT de sessão>"}`.
3. Qualquer outra primeira mensagem, token inválido/expirado, usuário removido ou silêncio → o servidor responde `{"type":"error","code":"unauthorized",...}` (quando há como) e fecha com o código **1008**. Um `?token=` na URL é ignorado.
4. Origem de navegador fora de `CORS_ORIGINS` → `403` antes do upgrade. Sem cabeçalho `Origin` (scripts, processo principal do Electron) passa.
5. Recusas antes do upgrade: `503` se o teto global de conexões (`WS_MAX_CONNS`, 200) foi atingido.

### Snapshot e mudanças, com sequência

Logo depois do `auth`, o servidor envia o **snapshot** completo (os 7 canais, vazios inclusive) com o número de sequência `seq` do instante. Daí em diante só chegam as **mudanças**, cada uma com `seq` = anterior + 1.

- `seq` é global (todos os canais) e cresce a cada mudança de presença. O snapshot e a inscrição nos eventos são feitos de forma atômica: o primeiro evento depois do snapshot S tem `seq = S.seq + 1`.
- Se o cliente vir um salto de `seq`, perdeu um evento: deve **reconectar** (e recebe um snapshot novo). O mesmo vale se a conexão cair.
- `participant_left` implica o fim de qualquer transmissão da pessoa (não vem `stream_stopped` antes).
- Uma pessoa que reconecta ao LiveKit sem passar por "saiu" continua na lista (sem `participant_left` + `participant_joined`); se estava transmitindo, vem `stream_stopped`.
- `participant_joined` já traz `isScreenSharing`, que pode ser `true` (ex.: descoberta pela reconciliação com a tela já publicada). Trate `participant_joined{isScreenSharing:true}` e `participant_joined` + `stream_started` como equivalentes.

### Mensagens do servidor

Os formatos exatos são os schemas `Ws*` de [contracts/openapi.yaml](../contracts/openapi.yaml) (fonte única para os tipos Go e TypeScript).

| `type` | Campos | Quando |
|---|---|---|
| `snapshot` | `seq`, `channels: [{channelId, participants: [{userId, username, isScreenSharing}]}]` | uma vez, após o `auth` |
| `participant_joined` | `seq`, `channelId`, `participant` | alguém entrou no canal |
| `participant_left` | `seq`, `channelId`, `userId` | alguém saiu do canal |
| `stream_started` | `seq`, `channelId`, `userId` | começou a compartilhar a tela |
| `stream_stopped` | `seq`, `channelId`, `userId` | parou de compartilhar a tela |
| `mention` | `from: {id, username}`, `message?`, `sentAt` | você foi chamado (sem `seq`) |
| `mention_sent` | `ref?` | confirma ao remetente que a menção foi entregue |
| `error` | `code`, `message`, `ref?` | veja os códigos abaixo |

### Mensagens do cliente

- `{"type":"auth","token":"..."}` — só como primeira mensagem.
- `{"type":"mention","targetUserId":"...","message":"...","ref":"..."}` — `message` opcional (até 140 caracteres, contados em runas), `ref` opcional (até 64) devolvido na confirmação ou no erro.

### Menções ("chamar atenção")

- Entrega em tempo real **só a quem está conectado** (a todas as conexões do destinatário). Nada é persistido.
- Destinatário sem conexão → `error` com `code: "recipient_offline"` na hora (ou `unknown_user` se o id não existe).
- Limites de frequência numa janela de `MENTION_WINDOW` (30 s): `MENTION_SENDER_LIMIT` (5) por remetente e `MENTION_RECIPIENT_LIMIT` (5) por destinatário. O limite do remetente é aplicado antes de qualquer consulta ao banco; o do destinatário só é gasto quando a menção seria entregue (tentativas a quem está offline não o consomem). A mensagem de erro diz em quantos segundos tentar de novo.
- Qualquer usuário conectado pode chamar qualquer outro (não precisa estar no mesmo canal).

| `error.code` | Significado |
|---|---|
| `unauthorized` | autenticação ausente ou inválida (a conexão é fechada) |
| `bad_message` | JSON/tipo inválido, mensagem acima de 140 caracteres, `targetUserId` ausente |
| `self_mention` | tentou chamar a si mesmo |
| `rate_limited_sender` | você chamou atenção vezes demais |
| `rate_limited_recipient` | essa pessoa já foi chamada vezes demais |
| `recipient_offline` | destinatário sem conexão ativa |
| `unknown_user` | destinatário não existe |

### Robustez

- **Ping/pong**: o servidor envia um ping a cada `WS_PING_INTERVAL` (20 s) e espera o pong por até 10 s; sem resposta, fecha a conexão. Clientes de navegador/Electron respondem sozinhos; clientes de teste precisam estar lendo o socket.
- **Limite por usuário**: no máximo `WS_MAX_CONNS_PER_USER` (3) conexões simultâneas. A 4ª **derruba a mais antiga** (1008, "substituída por uma conexão mais nova"), em vez de recusar a nova: quem reconecta depois de uma queda de rede não fica barrado enquanto o servidor ainda não percebeu que a conexão antiga morreu.
- **Consumidor lento**: fila de saída limitada (64 mensagens) e buffer de eventos de presença (256); se estourar, a conexão é encerrada (1008) e o cliente reconecta e recebe um snapshot novo.
- **Mensagens inválidas**: 5 seguidas encerram a conexão (1008). Frames do cliente têm no máximo 4 KiB.
- **Encerramento do servidor**: as conexões recebem o código **1001** (going away). O cliente deve reconectar com espera crescente.
- Todos os fechamentos educados usam o motivo em texto no frame de close.

## 4. Variáveis

| Variável | Padrão | |
|---|---|---|
| `LIVEKIT_URL` | deriva de `LIVEKIT_PUBLIC_URL` (ws→http) | endereço HTTP do LiveKit que o **backend** usa (RoomService) |
| `RECONCILE_INTERVAL` | `60s` | período da reconciliação |
| `WS_AUTH_TIMEOUT` | `5s` | prazo para o `auth` |
| `WS_PING_INTERVAL` | `20s` | intervalo entre pings |
| `WS_MAX_CONNS_PER_USER` | `3` | conexões simultâneas por usuário |
| `WS_MAX_CONNS` | `200` | teto global de conexões |
| `MENTION_SENDER_LIMIT` / `MENTION_RECIPIENT_LIMIT` | `5` / `5` | menções por janela |
| `MENTION_WINDOW` | `30s` | janela dos limites de menção |

## 5. Atrás do Caddy (R3)

O WebSocket e o webhook passam pelo mesmo backend. O webhook é chamado pelo LiveKit pela rede interna do Compose (`http://backend:8080/webhooks/livekit`), não pela internet: não precisa ser exposto no Caddy. `/ws` precisa de proxy com suporte a WebSocket (o Caddy faz isso por padrão) e os `TRUSTED_PROXIES` configurados.
