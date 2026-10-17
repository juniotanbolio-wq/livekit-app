# frontend

Cliente desktop Windows: Electron (electron-vite) + React + TypeScript estrito + Tailwind. Gera um `.exe` na fase R4. Não contém segredos: o endereço do servidor é pedido na primeira execução, validado em `GET /health` e salvo em `settings.json` no `userData` do Electron (editável em Configurações > Servidor).

## Comandos

```powershell
npm install
npm run dev              # app em modo desenvolvimento (Vite em http://localhost:5173)
npm run dev:second       # segunda instância (dados em .electron-second) para testar voz local
npm run typecheck
npm run lint
npm run build
npm run format
npm run generate         # tipos e limites a partir de ../contracts/openapi.yaml
npm run generate:check   # falha se src/generated estiver desatualizado em relação ao contrato
npm run e2e              # aceite da R2 (veja abaixo)
```

O backend de desenvolvimento é o Compose de `../infra` (`docker compose up -d --build` e `docker compose exec backend /server seed`); no app, use `http://localhost:8080` (já vem pré-preenchido fora do pacote).

## Conteúdo

- `src/main/`: processo principal: janela e bandeja (`index.ts`, `tray.ts`), segurança e CSP (`security.ts`), validação do servidor (`server-check.ts`), configurações (`settings-store.ts`), sessão cifrada com safeStorage (`session-store.ts`), notificações do Windows (`notifications.ts`), IPC (`ipc.ts`) e captura de tela
- `src/preload/`: ponte mínima e tipada entre main e renderer
- `src/shared/`: contrato IPC entre main e renderer
- `src/generated/`: **gerado** de `contracts/openapi.yaml` (`api.ts`: tipos REST e `Ws*`; `contract.ts`: limites de validação). Não editar à mão
- `src/renderer/`: interface React. `lib/api.ts` (cliente REST com `openapi-fetch`), `lib/realtime.ts` (WebSocket de presença e menções), stores Zustand, telas de servidor, login, voz, Modo Espectador, compartilhamento de tela, menções e painel de depuração (Ctrl+Shift+D)
- `scripts/`: `generate-api.mjs` (geração) e `e2e.mjs` (aceite)

## Como funciona (R2)

- **Servidor**: o processo principal faz `GET /health` (o renderer não alcançaria um servidor fora da CSP), exige `https://` fora do localhost e guarda o servidor e o `livekitUrl` informado por ele. A CSP (`connect-src`) passa a liberar só essas duas origens; por isso salvar recarrega a página. Trocar de servidor apaga a sessão salva.
- **Sessão**: `401` em qualquer chamada autenticada (ou `unauthorized` no WebSocket) leva ao login com aviso; sair fecha o WebSocket.
- **Presença**: só pelo WebSocket (sem polling): snapshot e depois eventos com `seq` contíguo; salto de `seq` reconecta para um snapshot novo; quedas reconectam com espera exponencial e jitter, com "Reconectando..." no topo da barra lateral. Protocolo em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).
- **Chamar atenção**: sino ao passar o mouse sobre alguém num canal de voz, com mensagem opcional (até 140 caracteres). Quem recebe vê um aviso no app e um toast do Windows com som.
- **Bandeja**: o X da janela só esconde (o app segue conectado e recebendo menções); "Abrir" e "Sair" no ícone da bandeja.
- **Mídia**: voz, Modo Espectador e tela não mudaram; o token e a URL do LiveKit vêm de `POST /api/livekit/token`.

## Aceite automatizado (`npm run e2e`)

Pré-requisitos: Compose de `../infra` no ar e com seed. O script compila o app, gera dois convites com `docker compose exec backend /server invite create`, abre **duas instâncias reais** do app compilado (`app://desktop`) com câmera e microfone falsos e as dirige pelo Chrome DevTools Protocol. Cobre: endereço do servidor (inválido, sem TLS, válido), cadastro, sessão expirada, voz, transmissão AO VIVO pela presença, Modo Espectador assinando só `screen_share`, menções nos dois sentidos (aviso + toast), bandeja, reinício do backend (`docker compose restart backend`) com reconexão e presença correta, limite de menções, destinatário offline e logout fechando o WebSocket.

- O seletor lista as telas reais desta máquina, mas a flag de mídia falsa faz o Chromium publicar um padrão animado de 1920x1080 a 60 fps no lugar da captura. O teste confere que o espectador recebe a camada de 1080p; o fps é só registrado (com OpenH264 em software e as duas instâncias na mesma máquina fica bem abaixo de 60, assunto da R5).
- O teste deixa usuários `e2e_*` no banco de desenvolvimento e reinicia o contêiner `backend`.
- Cada execução faz 3 chamadas de autenticação, e o backend aceita 10 (cadastro + login) a cada 15 min por IP. Rodando várias vezes seguidas, aparece "Muitas tentativas": espere ou rode `docker compose restart backend` em `../infra` (o limite fica em memória).
- `npm run e2e -- --screenshots <pasta>` salva capturas das etapas principais; `--no-build` pula a compilação.

## Checklist de teste manual (R2)

Preparação: `cd ..\infra; docker compose up -d --build; docker compose exec backend /server seed`, dois convites (`docker compose exec backend /server invite create`), `npm run dev` e `npm run dev:second`.

Servidor e sessão

- [ ] Primeira execução mostra "Conectar a um servidor" com `http://localhost:8080` preenchido.
- [ ] `http://localhost:9` → erro de conexão claro; `http://exemplo.com` → erro pedindo `https://`; `http://localhost:8080` → tela de login.
- [ ] Login mostra "Servidor: http://localhost:8080 · Alterar"; "Alterar" volta para a tela do servidor e "Voltar" retorna.
- [ ] Cadastro com convite gerado pelo backend Go; convite reutilizado → erro claro.
- [ ] Fechar e reabrir o app entra direto (sessão salva); trocar o servidor em Configurações > Servidor pede login de novo.
- [ ] (Opcional) Trocar o `JWT_SECRET` do `infra/.env` e rodar `docker compose up -d` → o app volta ao login com "Sua sessão expirou" (todas as sessões antigas deixam de valer).

Presença pelo WebSocket

- [ ] DevTools (Ctrl+Shift+I) > Network: nenhuma requisição periódica de presença; só o WebSocket `/ws`.
- [ ] A entra em "Voz 1" → B vê A embaixo do canal em até 1 s.
- [ ] A compartilha a tela → B vê o selo AO VIVO no canal e o ícone de tela ao lado de A.
- [ ] `docker compose restart backend` → "Reconectando..." aparece no topo da barra lateral nos dois e some em poucos segundos; a presença volta certa (quem está em cada canal e quem transmite).
- [ ] `docker compose stop backend` por 1 minuto → "Reconectando..." continua, sem travar a interface; `docker compose start backend` → reconecta sozinho.
- [ ] Sair da conta: o log do backend mostra `websocket desconectado` e não há reconexão.

Mídia (inalterada; conferir que continua igual à v1)

- [ ] Voz entre A e B com indicador de fala, mutar, ensurdecer, câmera e troca de dispositivos.
- [ ] B assiste a tela de A no Modo Espectador; no painel de depuração (Ctrl+Shift+D), seção Espectador: só `screen_share` assinado, microfone e câmera "não".
- [ ] Tela em 1080p60 (captura e recepção no painel de depuração) e tela cheia no player.

Chamar atenção

- [ ] B passa o mouse sobre A no canal, clica no sino, escreve uma mensagem e envia → "Atenção enviada".
- [ ] A recebe o toast do Windows **com som** e o aviso no canto inferior direito do app, com a mensagem.
- [ ] Clicar no toast abre/foca a janela; com a janela fora de foco, o botão da barra de tarefas pisca.
- [ ] Sentido inverso (A → B) sem mensagem.
- [ ] Contador de 140 caracteres; acima disso o botão fica desabilitado.
- [ ] 6 chamadas seguidas em menos de 30 s → "Limite atingido. ... tente de novo em N s".
- [ ] Destinatário offline: encerre B pelo Gerenciador de Tarefas enquanto ele está num canal e chame B em seguida → "B está offline".

Bandeja

- [ ] O X da janela esconde o app; aparece o aviso "LiveKit App continua aberto" na primeira vez.
- [ ] Com a janela escondida, chamar a atenção dela → toast com som; clicar no toast reabre a janela.
- [ ] Ícone da bandeja: clique abre; menu "Abrir" abre; "Sair" encerra de vez (sai da voz).
- [ ] Abrir o app de novo com ele na bandeja (sem `--multi-instance`) só traz a janela de volta.
