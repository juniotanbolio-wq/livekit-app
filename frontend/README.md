# frontend

Cliente desktop Windows: Electron (electron-vite) + React + TypeScript estrito + Tailwind. Não contém segredos: o endereço do servidor é pedido na primeira execução, validado em `GET /health` e salvo em `settings.json` no `userData` do Electron (editável em Configurações > Servidor).

## Comandos

```powershell
npm install
npm run dev              # app em modo desenvolvimento (Vite em http://localhost:5173)
npm run dev:second       # segunda instância (dados em .electron-second) para testar voz local
npm run typecheck
npm run lint
npm run build
npm run format
npm test                 # testes unitários (algoritmo do noise gate)
npm run generate         # tipos e limites a partir de ../contracts/openapi.yaml
npm run generate:check   # falha se src/generated estiver desatualizado em relação ao contrato
npm run e2e              # aceite com duas instâncias reais, em servidor descartável (veja abaixo)
npm run medir            # medição de qualidade da tela (docs/medicoes.md)
npm run package          # .exe portátil e dist/win-unpacked (teste; assinatura e instalador na R4)
```

O backend de desenvolvimento é o Compose de `../infra`; no app, use `http://localhost:8080` (pré-preenchido fora do pacote). Para subir tudo e abrir duas instâncias do app empacotado de uma vez, use o "Iniciar teste" (README da raiz).

## Conteúdo

- `src/main/`: processo principal: janela e bandeja (`index.ts`, `tray.ts`), segurança e CSP (`security.ts`), features do Chromium para codificação por GPU (`media-flags.ts`), validação do servidor (`server-check.ts`), configurações (`settings-store.ts`), sessão cifrada com safeStorage (`session-store.ts`), notificações do Windows (`notifications.ts`), IPC (`ipc.ts`), diagnóstico de GPU/CPU para o painel (`diagnostics.ts`) e captura de tela
- `src/preload/`: ponte mínima e tipada entre main e renderer
- `src/shared/`: contrato IPC entre main e renderer
- `src/generated/`: **gerado** de `contracts/openapi.yaml`. Não editar à mão
- `src/renderer/`: interface React. `lib/api.ts` (REST), `lib/realtime.ts` (WebSocket), `lib/rtc-stats.ts` (estatísticas WebRTC), `lib/codec-selection.ts` (codec automático), `voice/` (salas LiveKit, regras de assinatura, processamento de voz com RNNoise e noise gate), stores Zustand e telas
- `scripts/`: `e2e.mjs` (aceite), `medir.mjs` (medição), `lib/` (servidor descartável, CDP, instâncias do app), `tests/` (unitários), `generate-api.mjs`
- `electron-builder.yml`: empacotamento de teste

## Como funciona a mídia (Fase Q)

- **Codec da tela**: "Automático" escolhe o primeiro codificado pela GPU, nesta ordem: H.264 > AV1 > H.264 em software. Primeiro vale o resultado já medido nesta máquina; sem ele, a previsão do Chromium (`MediaCapabilities`). O processo principal liga as features do Chromium que permitem isso no Windows (`media-flags.ts`); `--no-hw-encode-flags` desliga.
- **Assistir sob demanda**: na voz, microfones e câmeras (camada média) são assinados sozinhos; a tela de alguém só depois de "Assistir", e "Parar de assistir" cancela. Sem espectador, o dynacast faz quem transmite parar de codificar.
- **Camada máxima**: as duas salas rodam sem `adaptiveStream`, então a tela assistida vem sempre na camada mais alta. O SFU só desce de camada quando a banda de quem assiste não comporta.
- **Degradação**: `maintain-resolution`; em sobrecarga cai o fps, não a resolução.
- **Voz**: eco e ganho automático do navegador sempre ligados. Supressão de ruído Desligada / Padrão (nativa) / Avançada (RNNoise local, em AudioWorklet + WASM). Noise gate opcional, com limite ajustável. Opus de 64 kbps com RED e DTX.
- **Testar microfone**: em Configurações > Áudio, toca a própria voz já processada no dispositivo de saída escolhido.
- **Áudio da tela**: estéreo, 128 kbps, sem processamento de voz; liga junto com o "Assistir" e a escolha fica salva.
- **Painel de depuração** (Ctrl+Shift+D):
  - por camada: resolução, fps, bitrate, codec, codificador, hardware ou software, limitação e ms por quadro;
  - fps medido da fonte, estimativa de banda, CPU e GPU;
  - processamento do microfone.

## Aceite automatizado (`npm run e2e`)

Roda isolado: sobe LiveKit e backend próprios, com rede, volume e segredos descartáveis e portas 27880-27882 e 28080. Não toca no Compose de desenvolvimento nem no banco dele. Só precisa do Docker Desktop. Abre **duas instâncias reais** do app compilado, com câmera, microfone e tela falsos (padrão animado 1920x1080, pedido a 60 fps), e as dirige pelo Chrome DevTools Protocol.

Cobre:
- servidor, cadastro, sessão expirada e presença;
- transmissão AO VIVO e Modo Espectador só com a tela;
- emissor sem espectador com as camadas pausadas;
- codec automático e codificador por hardware;
- assistir pela voz na camada máxima, "Parar de assistir" cancelando a assinatura, e "Assistir" pela grade;
- processamento do microfone (Padrão, Avançada com RNNoise, gate), Opus 64 kbps, RED e DTX;
- áudio da tela sem processamento;
- menções, bandeja, reinício do backend, limite de menções, offline e logout.

Opções:
- `--exe <caminho>` roda o mesmo aceite no app empacotado;
- `--screenshots <pasta>` salva capturas;
- `--no-build` pula a compilação.

## Checklist de teste manual

O roteiro de **mídia com tela real** (1 PC e 2 PCs) está em [../docs/medicoes.md](../docs/medicoes.md#checklist-de-teste-real). Para o resto, abra duas instâncias pelo "Iniciar teste" (`-Convites 2` gera os convites).

Servidor e sessão

- [ ] Primeira execução mostra "Conectar a um servidor" com `http://localhost:8080` preenchido.
- [ ] `http://localhost:9` → erro de conexão claro; `http://exemplo.com` → erro pedindo `https://`; `http://localhost:8080` → tela de login.
- [ ] Cadastro com convite; convite reutilizado → erro claro.
- [ ] Fechar e reabrir o app entra direto (sessão salva); trocar o servidor em Configurações > Servidor pede login de novo.

Presença, menções e bandeja

- [ ] A entra em "Voz 1" → B vê A embaixo do canal em até 1 s; A compartilha a tela → B vê o selo AO VIVO.
- [ ] `docker compose -f infra\docker-compose.yml restart backend` → "Reconectando..." aparece e some; a presença volta certa.
- [ ] B chama a atenção de A com mensagem → toast do Windows com som e aviso no app; 6 chamadas em 30 s → "Limite atingido".
- [ ] O X da janela esconde o app; com ele na bandeja, chamar a atenção → toast; "Sair" no ícone encerra de vez.
