# Notas técnicas

Detalhes de implementação, decisões por fase e pegadinhas conhecidas. O `CLAUDE.md` traz só o essencial e aponta para cá. Atualizar ao fim de cada fase.

## Ambiente de desenvolvimento

- Windows + VS Code + Docker Desktop. **Go, gcc e golangci-lint não estão instalados no Windows (e não devem ser sem perguntar)**: todo comando Go roda em contêiner pelos scripts de `backend/scripts/`.
- Scripts em **PowerShell 7** (`pwsh`, 7.6+; todos com `#Requires -Version 7.0`). Rodar a partir de `backend/`: `pwsh -NoProfile -File scripts\<nome>.ps1`.
  - `check.ps1`: generate sem deriva, build, vet, `test -race`, lint (roda todas as etapas e resume).
  - `test.ps1`, `lint.ps1`, `generate.ps1`, `go.ps1 <args>`, `e2e.ps1` (aceite do backend).
  - Caches em volumes Docker `livekit-go-mod`, `livekit-go-build`, `livekit-lint-cache`. Imagens: `golang:1.27`, `golangci/golangci-lint:v2.15.0`.
- Frontend é um projeto npm independente (sem workspace na raiz). Em `frontend/`: `npm run dev`, `dev:second`, `typecheck`, `lint`, `build`, `format`, `generate`, `generate:check`, `e2e`.

## Backend (`backend/`)

- Módulo `livekit-app/backend`, Go 1.27, `net/http` + código gerado do contrato (oapi-codegen v2.8.0, strict server, spec embutida e validada por `nethttp-middleware`), SQLite `modernc.org/sqlite` (1 conexão, WAL), goose (migrações embutidas, aplicadas ao subir), sqlc v1.31.1. Código gerado commitado (`internal/api`, `internal/store`); regenerar com `generate.ps1`.
- Contrato em OpenAPI **3.0.3** (o oapi-codegen não suporta 3.1).
- Comandos do binário: `server [serve]`, `server seed` (7 canais `voice-1..voice-7`, nomes "Voz N", + admin; idempotente), `server invite create [--hours N]`. No contêiner: `docker exec <c> /server invite create`.

### Endpoints (porta 8080)

| Rota | Auth | Notas |
|---|---|---|
| `GET /health` | não | `{status, livekitUrl}` (o `livekitUrl` entrou na R2) |
| `POST /api/auth/register` / `login` | não | `{token, user}`; rate limit por IP compartilhado |
| `GET /api/channels` | Bearer | 7 canais em ordem |
| `POST /api/livekit/token` | Bearer | `{channelId, role: voice\|spectator}` → `{token, url, roomName}` |
| `GET /ws` | 1ª mensagem `{type:"auth",token}` | fora dos `paths` do OpenAPI; mensagens = schemas `Ws*` (`skip-prune: true`) |
| `POST /webhooks/livekit` | assinatura do LiveKit | fora do OpenAPI |

`/ws` e `/webhooks/livekit` ficam num `ServeMux` raiz em `httpapi.NewHandler`, fora da cadeia do validador (que devolveria 404). Erros: `{error, details?}`. Protocolo completo em [protocolo-tempo-real.md](protocolo-tempo-real.md).

### Variáveis (ver `backend/.env.example`)

- Obrigatórias: `JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (segredos com 32+ caracteres).
- Opcionais: `HTTP_ADDR` (:8080), `LOG_LEVEL` (info), `DATABASE_PATH` (data/app.db; na imagem /data/app.db), `JWT_TTL` (7d), `CORS_ORIGINS`, `LIVEKIT_PUBLIC_URL` (ws://localhost:7880), `LIVEKIT_URL` (HTTP interno do LiveKit para o RoomService; padrão deriva do público), `LIVEKIT_TOKEN_TTL` (6h), `INVITE_TTL_HOURS` (72), `AUTH_RATE_LIMIT` (10) / `AUTH_RATE_WINDOW` (15m), `MAX_BODY_BYTES` (32768), `TRUSTED_PROXIES` (vazio; definir na R3 com a rede do Caddy), `RECONCILE_INTERVAL` (60s), `WS_AUTH_TIMEOUT` (5s), `WS_PING_INTERVAL` (20s), `WS_MAX_CONNS_PER_USER` (3), `WS_MAX_CONNS` (200), `MENTION_SENDER_LIMIT` (5) / `MENTION_RECIPIENT_LIMIT` (5) / `MENTION_WINDOW` (30s), `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` (só no `seed`).

### Decisões da R1a (identidade)

- Convite guardado só como SHA-256 (o código em claro só aparece no `invite create`); username único sem diferenciar maiúsculas; senha argon2id (64 MiB, t=3, p=2, no máx. 4 hashes simultâneos); JWT HS256 de sessão.
- Rate limit compartilhado entre register e login, por IP (IPv6 por /64); `X-Forwarded-For` só de `TRUSTED_PROXIES`; origem fora do CORS recebe 403.
- Token LiveKit com todas as permissões explícitas (no LiveKit, `nil` vale `true`), emitido com `livekit/protocol/auth`; sala `channel-<id>`; ids de canal `voice-N`.

### Decisões da R1b (tempo real)

- Presença **só em memória** (`internal/presence`), reconstruída do LiveKit ao iniciar e a cada 60 s (`internal/livekit/roomsync.go`); consulta que falha não aplica nada.
- Eventos idempotentes por `sid` + lápides de 2 min para webhooks fora de ordem. Fora da presença: `hidden` e identidades `#spectator`. Tela = trilha `SCREEN_SHARE`. `participant_left` implica fim da transmissão; `participant_joined` já traz `isScreenSharing`.
- WebSocket: auth pela 1ª mensagem (token fora da URL), snapshot + mudanças com `seq` contíguo, ping 20 s / pong 10 s, fila de saída limitada (lento = desconecta), 3 conexões por usuário (**a mais antiga cai**), fechamentos 1008/1001.
- Menções: só a conectados, sem persistência, ≤ 140 runas, limite por remetente (antes de qualquer consulta ao banco) e por destinatário (só gasto se for entregar).

## Frontend (`frontend/`)

### Decisões da R2

- Tipos gerados de `contracts/openapi.yaml` em `src/generated/` (`api.ts`: REST e `Ws*`; `contract.ts`: limites de validação lidos do YAML), commitados. `openapi-typescript` 7.13 com `overrides` para aceitar o TypeScript 6. Cliente REST com `openapi-fetch` (`src/renderer/src/lib/api.ts`); WebSocket em `lib/realtime.ts`.
- Endereço do servidor pedido na 1ª execução (padrão `http://localhost:8080` fora do pacote), validado pelo **processo principal** com `GET /health` (`net.fetch`, 5 s) e salvo em `userData/settings.json` com o `livekitUrl` devolvido; `http`/`ws` só para localhost. A CSP (`connect-src`) é recalculada a partir dessas duas origens e a página recarrega ao salvar; trocar de servidor apaga a sessão. O renderer confere que a URL do token é da origem do LiveKit salvo.
- 401 em chamada autenticada ou `unauthorized` no WebSocket → login com aviso; sair fecha o WebSocket (1000).
- WebSocket: snapshot em até 10 s, salto de `seq` reconecta, backoff exponencial com full jitter (1 s → 30 s), reconexão no evento `online`; "Conectando..."/"Reconectando..." no topo da barra lateral.
- "Chamar atenção" (R2): só para quem aparece num canal de voz; mensagem opcional (140 runas); erros mapeados (offline, limite com os segundos do servidor). Menção recebida: aviso no app + toast do Windows com som pelo main (`Notification`, `silent:false`, `flashFrame`; loga `notificação de menção exibida`). *Decisão revista na Fase A: passar a valer para qualquer usuário conectado ao WebSocket.*
- Bandeja: o X esconde, "Abrir"/"Sair" no ícone (provisório, desenhado em código até a R4), `backgroundThrottling: false`, `setAppUserModelId`.

### Decisões da Fase Q (qualidade de áudio e vídeo)

Números e checklist de teste real em [medicoes.md](medicoes.md).

Codificação por GPU (`src/main/media-flags.ts`):
- Antes da Fase Q, tudo saía em software no Chromium 152 do Windows: H.264 no OpenH264, VP8 no libvpx e AV1 no libaom.
- O LiveKit negocia H.264 Constrained Baseline (`42e01f`), e no Windows o Chromium só entrega esse perfil ao codificador da GPU com a feature `PlatformH264CbpEncoding`, desligada por padrão.
- O processo principal liga, antes do `ready`, a feature `PlatformH264CbpEncoding`. Ele a junta às `--enable-features` que já vierem, e `--no-hw-encode-flags` a desliga.
- `WebRtcAV1HWEncode` e `D3D12VideoEncodeAcceleratorL1T3` foram testadas e deixadas de fora: com elas o AV1 continuou em `libaom` (L1T1 e L1T3, RX 9070 XT, Chromium 152). Para testar em outra GPU, passe-as em `--enable-features` ao abrir o app.
- Resultado na RX 9070 XT: `SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (AMDh264Encoder) ×3)`.

Codec automático (`lib/codec-selection.ts`):
- Ordem: H.264 HW > AV1 HW > H.264 SW.
- Vale primeiro o resultado já medido nesta máquina, gravado no localStorage por versão do Chromium + GPU + driver; sem ele, a previsão de `navigator.mediaCapabilities.encodingInfo({type:'webrtc'})` (perfil CBP / L1T3, 1080p60).
- `stores/screen-share.ts` confere `powerEfficientEncoder` a cada 5 s enquanto a tela está ao vivo e grava o resultado, só quando houve quadros codificados no intervalo.
- As configurações salvas antes da Fase Q têm o codec descartado (versão 2), porque guardavam "h264" só por ser o padrão antigo.

Tela:
- `degradationPreference: maintain-resolution` (antes: maintain-framerate); `contentHint: motion` continua.

Assinaturas sob demanda (`voice/subscriptions.ts`):
- As duas salas conectam com `autoSubscribe: false` e `adaptiveStream: false`.
- No livekit-client 2.23, `adaptiveStream` é da sala inteira e passa por cima de `setVideoQuality`: com ele, quem assistia pela voz recebia 720p na janela padrão.
- Voz: microfone e câmera (camada MEDIUM) sempre; tela e áudio da tela só da transmissão escolhida em `useWatch`. Espectador: regra antiga.
- `useWatch.applySubscriptions()` aplica nas duas salas e roda a cada mudança de trilha, participante, conexão, seleção, player visível ou áudio ligado.
- Sem espectador, o dynacast pausa as camadas do emissor (`active=false`, upload 0).

Áudio:
- O `RoomAudioRenderer` saiu: ele tocava todo áudio assinado, inclusive o da tela. No lugar, `MicrophoneAudio` toca só os microfones e `StreamAudio` toca o áudio da transmissão assistida, com volume próprio e ensurdecer.
- O áudio do stream liga junto com o "Assistir", e a escolha fica salva em `watch.audio`.

Voz (`stores/audio-settings.ts`, `voice/audio-processing.ts`):
- Eco e ganho do navegador sempre ligados. Supressão:
  - off: nenhuma;
  - standard: nativa, com `voiceIsolation`;
  - advanced: RNNoise com a nativa desligada.
- Gate opcional, de -80 a -10 dB.
- O processamento local é um `TrackProcessor` do livekit-client com `AudioContext` próprio a 48 kHz: fonte → [RNNoise] → medidor → [gate] → `MediaStreamDestination` mono. RNNoise e gate têm entrada mono explícita (ver pegadinha dos -6 dB).
- Mudar de modo reinicia a captura só quando a supressão nativa muda; gate e limite mudam ao vivo, sem trocar a trilha publicada.
- O RNNoise vem de `@sapphi-red/web-noise-suppressor` (MIT; RNNoise BSD-3 via `@shiguredo/rnnoise-wasm`, Apache-2.0). O gate é nosso (`noise-gate.worklet.js`): ataque de 5 ms, fechamento de 50 ms, retenção de 200 ms, histerese de 6 dB e limite como AudioParam.
- Opus da voz: `maxBitrate` 64 kbps, `red: true`, `dtx: true` (`VOICE_PUBLISH_OPTIONS`, também em `publishDefaults`). Áudio da tela: `getDisplayMedia` com eco, ruído e ganho desligados, estéreo, 128 kbps, sem DTX nem RED.

CSP:
- `script-src` ganhou `'wasm-unsafe-eval'`, que só permite compilar WebAssembly (o RNNoise roda em WASM dentro do AudioWorklet). `eval` de texto continua bloqueado.

Painel de depuração:
- Por camada: resolução, fps, bitrate, codec, codificador, `powerEfficientEncoder`, `qualityLimitationReason`, `active`, ms por quadro e modo SVC.
- Fonte: fps medido (`media-source`), estimativa de banda (`availableOutgoingBitrate`), RTT e `degradationPreference`.
- Microfone e áudio da tela: processamento aplicado (`getSourceTrackSettings`), processador, bitrate, codec e RED ativo (primeiro codec negociado no sender; a estatística `outbound-rtp` do Chromium mostra `audio/opus` mesmo com RED).
- Com o processador local: nível antes e depois do gate, nível do canal 0 da saída (deve ser igual ao downmix; o aceite falha com 6 dB de diferença) e se o sender envia a trilha processada.
- Sistema: novo IPC `diagnostics:get` com GPU, `video_encode`, features ativas e CPU por processo.
- O JSON completo fica em `data-debug-json`, lido pelos scripts.

Testes (achados T1 e T4 da auditoria):
- O `npm run e2e` agora é isolado (`scripts/lib/stack.mjs`):
  - LiveKit em 27880/27881/27882 com `livekit.yaml` copiado do repositório (troca só portas, chave e destino do webhook), `--node-ip 127.0.0.1`;
  - backend em 28080, imagem `livekit-backend:e2e`;
  - segredos de `crypto.randomBytes` validados e passados por arquivo de ambiente temporário (não pela linha de comando);
  - tudo com a etiqueta `livekit-app.test=frontend`, removido no fim, no Ctrl+C e na execução seguinte.
- Fonte falsa pedida a 60 fps. `npm run medir` (mesmo ambiente) gera a tabela de `medicoes.md`; `npm test` roda o teste unitário do gate (`node --test`).

Executável:
- `electron-builder` 26.15.3, alvos `portable` e `dir` (`electron-builder.yml`, `npm run package`). `appId` = `app.livekit.desktop`, igual ao `APP_USER_MODEL_ID`. Sem assinatura nem fuses (R4).
- `--default-server-url=` sugere o endereço na primeira execução também no pacote.

## Infra local (`infra/`)

- `docker-compose.yml` sobe **LiveKit + backend** (7880, 7881/TCP, 7882/UDP e 8080, todas em 127.0.0.1 exceto as do LiveKit).
- No dev a chave de API tem nome **fixo `devkey`** (compose `LIVEKIT_KEYS`, backend e `livekit.yaml` `webhook.api_key` precisam coincidir). `infra/.env` precisa de `LIVEKIT_API_SECRET`, `JWT_SECRET` e `SEED_ADMIN_PASSWORD` (os dois últimos gerados na R2, aleatórios).
- O Compose define `CORS_ORIGINS` (padrão: `http://localhost:5173`, `http://127.0.0.1:5173`, `app://desktop`). Webhook do LiveKit: `http://backend:8080/webhooks/livekit`.

## Testes de aceite

- `backend\scripts\e2e.ps1` (R1a + R1b, 63 checks, ~3 min): sobe LiveKit (17880), backend (18080) e bots numa rede Docker descartável, com cópia temporária do `livekit.yaml`, sem tocar no `infra/.env`. O bot `backend/cmd/e2ebot` (server-sdk-go) gera webhooks reais; o cliente WebSocket é `ClientWebSocket` do .NET.
- `frontend\scripts\e2e.mjs` (`npm run e2e`, R2 + Fase Q, ~6 min): duas instâncias do app compilado (ou do `.exe` com `--exe`), mídia falsa, dirigidas por CDP (portas 9311/9312), num servidor descartável (LiveKit 27880-27882, backend 28080; `scripts/lib/stack.mjs`). Não toca no Compose de dev.
- `frontend\scripts\medir.mjs` (`npm run medir`, CDP 9321/9322): mesmo ambiente, tabela de qualidade por codec e cenário.

## Pegadinhas conhecidas

### PowerShell
- Variáveis são case-insensitive (`$botS` sobrescrevia `$bots`).
- Array de 1 elemento é "desembrulhado" no retorno de função: use `, @(...)`.
- Com `$ErrorActionPreference = 'Stop'`, stderr de programa nativo pode virar exceção: leia logs de contêiner com `Get-ContainerLog` (troca para `Continue` localmente).
- `ReceiveAsync` do `ClientWebSocket`: cancelar a leitura aborta o socket; espere com timeout sem cancelar.
- No pwsh 7, `ConvertFrom-Json` converte textos de data ISO em `DateTime`.
- A mensagem de commit em here-string passada a um executável nativo pode ser quebrada nas aspas: use `git commit -F <arquivo>`.
- No PowerShell 5.1 (.NET Framework), `"texto".StartsWith([char]0xFEFF)` é comparação cultural e o BOM é ignorável: devolve `$true` para qualquer texto. Use `StartsWith(..., [StringComparison]::Ordinal)`. (Na Fase A isso apagou o `#` da primeira linha dos scripts.)
- Os scripts do backend estão em UTF-8 **sem BOM**: o pwsh 7 os lê certo; o 5.1 leria acentos errado (por isso exigem 7.0).

### Go / backend
- Com a `coder/websocket`, cancelar o contexto no meio de `Write`/`Ping`/`Read` fecha o socket sem handshake: escrita e ping usam `context.WithoutCancel`, e o leitor tem contexto próprio.
- Cliente de teste que não lê o socket não responde ao ping e é derrubado aos ~30 s.
- **Sem acentos em `internal/db/queries/*.sql`** (bug do sqlc com UTF-8).

### Electron / frontend
- **Sem `"type": "module"` no `package.json`**: com ele o electron-vite gera o preload em ESM (`index.mjs`), que não carrega com `sandbox: true` (o app abre sem `window.desktop`).
- Seletor Zustand nunca devolve `[]` ou objeto novo a cada leitura: laço infinito de renderização (erro React #185). Use uma constante.
- O ambiente do VS Code/Claude Code exporta `ELECTRON_RUN_AS_NODE`: remova-o para lançar o Electron por script, senão ele roda como Node ("bad option").
- `window.close()` pelo renderer fecha a janela sem o evento `close` do `BrowserWindow` (pula o "esconder na bandeja"); para simular o X, mande `WM_CLOSE`.
- O app empacotado tira o nome (e a pasta de perfil `%APPDATA%\<nome>`) do `package.json` dentro do `app.asar`, e o electron-builder não copia o `productName` da configuração para lá. Sem `extraMetadata.productName`, o `.exe` usava o perfil do `npm run dev` (`livekit-frontend`) e não abria com o dev aberto, por causa da trava de instância única. Confira com `require('@electron/asar').extractFile(...)`.
- Com `backgroundThrottling: false`, `document.visibilityState` fica sempre `visible`; para saber se a janela está escondida, use o Windows (`MainWindowHandle` = 0).
- `--use-fake-device-for-media-stream` também troca a captura de tela pelo padrão animado do Chromium (1920x1080@60); o seletor continua listando as telas reais.
- O backend de dev limita cadastro + login a 10 por 15 min por IP (`docker compose restart backend` zera, o limite é em memória). O aceite isolado sobe o dele com `AUTH_RATE_LIMIT=1000`.

### Mídia (Fase Q)
- No Windows, H.264 por GPU exige `--enable-features=PlatformH264CbpEncoding`, porque o LiveKit negocia Constrained Baseline. AV1 por GPU no WebRTC fica atrás de `WebRtcAV1HWEncode` (sem efeito na AMD testada). São features em teste no Chromium e os nomes podem mudar com a versão do Electron: depois de atualizar o Electron, confira no painel (`encoderImplementation`).
- `MediaCapabilities.encodingInfo({type:'webrtc'})` com `profile-level-id` no `contentType` funciona e responde por perfil: com a feature, só o H.264 Constrained Baseline (`42e01f`) aparece como `powerEfficient` na AMD.
- `app.commandLine.appendSwitch('enable-features', ...)` substitui o valor anterior da chave: junte com o que já existe (`media-flags.ts`).
- `adaptiveStream` no livekit-client vale para a sala toda e passa por cima de `setVideoQuality`/`setVideoDimensions` quando o elemento é menor. Para "sempre a camada máxima", só desligando na sala.
- `getAppMetrics().cpu.percentCPUUsage` já vem dividido pelo número de processadores lógicos: é % da máquina, não de um núcleo.
- `?url` do Vite embute arquivos pequenos como `data:` URL, e a CSP bloqueia worklet carregado de `data:`. Use `?url&no-inline` para AudioWorklet.
- A fonte de áudio falsa do Chromium (`--use-fake-device-for-media-stream`) é um bipe curto (20 ms a cada 500 ms) quase no volume máximo: não serve para medir nível nem gate. O aceite troca o microfone de A por um tom constante de -45 dBFS (`--use-file-for-fake-audio-capture=<wav>`, gerado por `writeToneWav`), e o algoritmo do gate tem teste próprio (`npm test`). Amostrar a cada 500 ms coincide com o período do bipe e esconde o problema.
- O microfone chega ao Web Audio em **estéreo** (L = R), mesmo com `getSettings().channelCount` = 1. Um AudioWorkletNode sem `outputChannelCount` (o `RnnoiseWorkletNode`) herda dois canais e, processando só o canal 0, deixa o 1 em silêncio: o downmix para mono do destino derrubava a voz em 6 dB. Force `channelCount = 1` + `channelCountMode = 'explicit'` nos nós da cadeia.
- A tela parada gera poucos quadros (o Chromium só recaptura quando a imagem muda): "1 fps" com a área de trabalho parada não é defeito. Meça com vídeo ou jogo em movimento.
- `getTrackReferenceId` não é exportado pelo `@livekit/components-react` (só pelo components-core, que não é dependência direta).
