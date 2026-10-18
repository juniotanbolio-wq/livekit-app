# Medições de qualidade (Fase Q)

Como medir de novo: `cd frontend; npm run medir` (ou `npm run medir -- --codecs auto,h264,av1`). O script sobe o servidor descartável do aceite, abre duas instâncias com a fonte de tela falsa do Chromium (padrão animado 1920x1080, pedido a 60 fps), e lê o painel de depuração (Ctrl+Shift+D) de A (quem transmite) e de B (quem assiste) por 10 s em quatro cenários:

| Cenário | O que B faz |
|---|---|
| sem espectador | B logado, fora do canal |
| espectador | B no Modo Espectador (segunda conexão, só a tela) |
| voz (sem clicar) | B na voz do canal, olhando a grade, sem clicar em nada |
| voz (assistindo) | B na voz, assistindo em tela grande |

Colunas: camadas enviadas por A (rid resolução@fps bitrate; "pausada" = o dynacast parou a camada porque ninguém a assiste), fps da fonte medido (não o pedido), upload total de A, `qualityLimitationReason`, ms de codificação por quadro da maior camada ativa (a 60 fps o orçamento é 16,7 ms), CPU de A em % da máquina inteira (16 threads; página = processo que codifica), o que B recebe e perdas/quadros descartados/congelamentos.

## Ambiente

- PC: AMD Ryzen 7 7800X3D (8 núcleos, 16 threads), AMD Radeon RX 9070 XT (driver 32.0.32015.2008) + iGPU AMD, Windows 11 Pro.
- App: Electron 44.8.0 (Chromium 152.0.7977.167), livekit-client 2.23.0, LiveKit Server 1.13.10.
- As duas instâncias rodam na mesma máquina, com LiveKit e backend em Docker Desktop (127.0.0.1): não há perda de rede real. A fonte falsa é simples de codificar (fundo parado com um contador animado): a CPU real com jogo ou vídeo será maior.

## Antes (baseline, 18/10/2026, sem mudanças de mídia)

Teste real feito pelo usuário antes da Fase Q (tela real, mesmo PC, duas instâncias):

| Caminho | Recebido | Codec |
|---|---|---|
| sala de voz | 1280x720 a 1 fps, 21 kbps | VP8 |
| Modo Espectador | 1920x1080 a 27 fps, 7,08 Mbps, sem perdas, jitter 3 ms | H.264 (OpenH264) |

`npm run medir -- --codecs h264,vp8,av1` (features do Chromium: nenhuma; `video_encode: enabled`):

| Cenário | Codec | Codificador (A) | HW | Camadas enviadas | Fonte | Upload A | Limitação | ms/q | CPU A página/GPU | Recebido em B | Perdas/desc./cong. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sem espectador | h264 | SimulcastEncoderAdapter (OpenH264) | não | todas pausadas | 55 fps | 0 kbps | bandwidth | - | 0,3/0 | - | - |
| espectador | h264 | SimulcastEncoderAdapter (OpenH264, OpenH264) | não | h 1280x720@30 2302k; q 640x360@15 202k; **f parada** | 50 fps | 2504 kbps | bandwidth | 3,1 | 1,0/0 | **1280x720@30** 540k | 0/0/0 |
| voz (sem clicar) | h264 | SimulcastEncoderAdapter (OpenH264) | não | q 640x360@15 167k; f e h pausadas | 15 fps | 167 kbps | none | 1,1 | 0,4/0 | 640x360@15 (prévia da grade) | 0/0/0 |
| voz (assistindo) | h264 | SimulcastEncoderAdapter (OpenH264, OpenH264) | não | h 1280x720@30 986k; q 640x360@15 162k; **f pausada** | 30 fps | 1148 kbps | none | 3,3 | 1,0/0 | **1280x720@30** 554k | 0/0/0 |
| sem espectador | vp8 | SimulcastEncoderAdapter (libvpx ×3) | não | todas pausadas | 55 fps | 0 kbps | none | - | 0,2/0 | - | - |
| espectador | vp8 | SimulcastEncoderAdapter (libvpx ×3) | não | f 1920x1080@51 2505k; h 1280x720@30 950k; q 640x360@16 295k | 52 fps | 3749 kbps | none | 4,6 | 4,8/0 | 1920x1080@50 2116k | 0/0/0 |
| voz (sem clicar) | vp8 | libvpx | não | q 640x360@15 268k; f e h pausadas | 15 fps | 268 kbps | none | 1,1 | 0,4/0 | 640x360@15 (prévia) | 0/0/0 |
| voz (assistindo) | vp8 | SimulcastEncoderAdapter (libvpx ×2) | não | h 1280x720@30 957k; q 640x360@15 267k; **f pausada** | 30 fps | 1225 kbps | none | 3,0 | 1,2/0 | **1280x720@30** 955k | 0/0/0 |
| sem espectador | av1 | libaom | não | pausada | 55 fps | 0 kbps | none | - | 0,2/0 | - | - |
| espectador | av1 | libaom | não | 1920x1080@51 1964k (L1T3) | 51 fps | 1964 kbps | none | 1,9 | 2,6/0 | 1920x1080@51 1968k | 0/0/0 |
| voz (sem clicar) | av1 | libaom | não | 1920x1080@51 2018k | 51 fps | 2018 kbps | none | 1,9 | 2,7/0 | **1920x1080@51 sem ninguém assistir** | 0/0/0 |
| voz (assistindo) | av1 | libaom | não | 1920x1080@51 1996k | 51 fps | 1996 kbps | none | 2,0 | 2,7/0 | 1920x1080@50 2001k | 0/0/0 |

O que o baseline mostra:
- **Nenhum codec usa a GPU.** H.264 sai pelo OpenH264, VP8 pelo libvpx e AV1 pelo libaom, todos em software, apesar de `video_encode: enabled`. Causa no Chromium 152, Windows:
  - o LiveKit negocia H.264 Constrained Baseline (`42e01f`), e o codificador de hardware só recebe esse perfil com a feature `PlatformH264CbpEncoding`, desligada por padrão no Windows;
  - AV1 por hardware no WebRTC está atrás de `WebRtcAV1HWEncode`, também desligada no Windows.
- **Na voz, quem assiste não recebe a camada máxima.** O `adaptiveStream` pede a camada pelo tamanho do player: assistindo em tela grande na janela padrão (1280x800) chega 720p30, e a camada de 1080p60 fica pausada. Na grade, a prévia da tela assina 360p sem ninguém clicar. Isso explica o "1280x720" do teste real; o "1 fps" vem da tela real parada, que o Chromium só recaptura quando muda.
- **AV1/VP9 (SVC) na voz manda 1080p cheio para quem só está na grade**: sem camadas de resolução, o tile pequeno recebe tudo.
- **H.264 no espectador ficou em 720p nos 15 s de estabilização** (limitação `bandwidth`, a camada de 1080p ainda não tinha subido). A estimativa de banda começa baixa e sobe aos poucos; no aceite a camada cheia chega em até 45 s.
- **O dynacast funciona**: sem ninguém na sala, o upload de A vai a 0.
- A fonte falsa entrega ~51-55 fps (pedido: 60).

## Depois (fim da Fase Q, 18/10/2026)

`npm run medir -- --codecs auto,h264,av1`, com o build final (feature do Chromium: `PlatformH264CbpEncoding`; `video_encode: enabled`):

| Cenário | Codec | Codificador (A) | HW | Camadas enviadas | Fonte | Upload A | Limitação | ms/q | CPU A página/GPU | Recebido em B | Perdas/desc./cong. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sem espectador | auto → h264 | SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (AMDh264Encoder)) | **sim** | todas pausadas | 55 fps | **0 kbps** | bandwidth | - | 0,2/0,2 | - | - |
| espectador | auto → h264 | MediaFoundation (AMDh264Encoder) ×2 | sim | h 1280x720@30 1935k; q 640x360@15 494k; f ainda subindo | 50 fps | 2429 kbps | bandwidth | 7,1 | 0,8/0,9 | 1280x720@30 (1º espectador, ver abaixo) | 0/0/0 |
| voz (sem clicar) | auto → h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | todas pausadas | 55 fps | **0 kbps** | none | - | 0,3/0,2 | **não assinada** | - |
| voz (assistindo) | auto → h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | f 1920x1080@53 7896k; h 1280x720@31 2508k; q 640x360@15 500k | 54 fps | 10903 kbps | none | 11,2 | 1,4/2,6 | **1920x1080@53 7905k** | 0/0/0 |
| sem espectador | h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | todas pausadas | 56 fps | 0 kbps | none | - | 0,2/0,4 | - | - |
| espectador | h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | f 1920x1080@52 7879k; h 1280x720@31 2499k; q 640x360@15 500k | 54 fps | 10878 kbps | none | 11,9 | 1,4/3,1 | **1920x1080@52 7873k** | 0/0/0 |
| voz (sem clicar) | h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | todas pausadas | 55 fps | 0 kbps | none | - | 0,3/0,4 | não assinada | - |
| voz (assistindo) | h264 | MediaFoundation (AMDh264Encoder) ×3 | sim | f 1920x1080@53 7890k; h 1280x720@30 2499k; q 640x360@15 500k | 54 fps | 10889 kbps | none | 11,1 | 1,4/2,9 | 1920x1080@53 7862k | 0/0/0 |
| sem espectador | av1 | libaom | não | pausada | 55 fps | 0 kbps | none | - | 0,2/0,4 | - | - |
| espectador | av1 | libaom | não | 1920x1080@51 1965k (L1T3) | 51 fps | 1965 kbps | none | 1,8 | 2,4/0,5 | 1920x1080@51 1970k | 0/0/0 |
| voz (sem clicar) | av1 | libaom | não | pausada | 55 fps | 0 kbps | none | - | 0,3/0,4 | não assinada | - |
| voz (assistindo) | av1 | libaom | não | 1920x1080@51 2004k | 51 fps | 2004 kbps | none | 1,8 | 2,5/0,4 | 1920x1080@51 2001k | 0/0/0 |

### Antes × depois

| Indicador | Antes | Depois |
|---|---|---|
| Codificador H.264 | OpenH264 ×3 (software) | **AMD Media Foundation ×3 (GPU)** |
| Codec padrão | H.264 fixo | Automático → H.264 por GPU (AV1 cai para software nesta máquina e não é escolhido) |
| Assistindo pela voz, tela grande | 1280x720@30 (camada de 1080p pausada pelo `adaptiveStream`) | **1920x1080@53**, 7,9 Mbps |
| Na voz sem clicar em nada | assinava prévia 360p (AV1: 1080p inteiro a 2 Mbps) | **nada assinado**, upload do emissor 0 |
| Espectador, H.264 | 720p nos 15 s de estabilização | 1080p52 depois da subida inicial (abaixo) |
| Upload do emissor com 1 espectador em 1080p60 | não chegava a 1080p | 10,9 Mbps (f 7,9 + h 2,5 + q 0,5), dentro do orçamento do plano |
| CPU do emissor com as 3 camadas ativas (% da máquina, página/GPU) | 4,8/0 (VP8 em software, única medição com as 3 camadas) | **1,4/2,9** (H.264 pela GPU) |
| Degradação em sobrecarga | maintain-framerate (cai resolução) | maintain-resolution (cai fps) |
| Voz | Opus 48 kbps (padrão do livekit-client), supressão nativa fixa | **Opus 64 kbps, RED ativo, DTX** (mudo: 0,00 kbps); supressão Desligada/Padrão/RNNoise; noise gate |

Notas:
- **Subida até 1080p no primeiro espectador.** Sem ninguém assistindo, o dynacast pausa tudo e a estimativa de banda de subida de quem transmite fica nos ~400 kbps iniciais. Quando o primeiro espectador chega, o WebRTC sobe essa estimativa ~8% por segundo. Medido com as duas instâncias do aceite (H.264, leitura a cada 250 ms; sondagem avulsa, fora do `medir.mjs`):

  | Situação | 640px | 1280px | 1920px |
  |---|---|---|---|
  | 1ª vez | 0,8 s | 18 s | 34 s |
  | 2ª vez, 20 s depois | 1 s | - | 2 s |
  | pela voz | - | - | 1 s |

  Por isso o cenário "espectador" do Automático (o primeiro da medição) ficou em 720p nos 15 s. Com `contentHint: detail` a 1ª vez caiu para 24 s numa amostra única: ganho pequeno, então a decisão (`motion`) não mudou. Acelerar essa subida fica para a R5.
- O H.264 por GPU gasta mais "ms por quadro" que o OpenH264 (11 ms contra 3): é a latência do pipeline da GPU, não CPU, e cabe nos 16,7 ms de 60 fps. A CPU real caiu.
- A fonte falsa entrega ~54 fps; o fps recebido acompanha a fonte. 60 fps reais só com tela real (checklist).

Áudio (validado no aceite, microfone de A com tom constante de -45 dBFS):
- RED ativo (primeiro codec negociado: `audio/red`). DTX: microfone mudo a 0,00 kbps; gate fechado a 0 kbps.
- RNNoise e gate enviam a trilha processada. Um defeito de canais que derrubava a voz em 6 dB no modo Avançado foi achado e corrigido; o aceite agora o detecta.

## Checklist de teste real

A mídia falsa prova o caminho (codificador, camadas, assinaturas), mas não a qualidade com conteúdo real. Este roteiro é para você, com tela de verdade. Anote os números do painel de depuração (Ctrl+Shift+D) e me mande; eles entram na tabela "teste real" acima.

### Preparação (1 PC, duas instâncias)

- [ ] Atalho "Iniciar teste" na área de trabalho (ou `pwsh -NoProfile -File infra\scripts\iniciar-teste.ps1 -Convites 2`): o Docker sobe, as duas janelas abrem. Cadastre uma conta em cada (ou entre com contas existentes).
- [ ] Para ver o log do Chromium (erros do capturador, item M5 da auditoria), use `npm run dev` e `npm run dev:second` em `frontend\` no lugar do atalho: o log aparece no terminal.

### Codificador por GPU (tela real, 1080p60)

- [ ] A entra em "Voz 1", clica em compartilhar, escolhe **a tela inteira**. O seletor mostra "Será usado: H.264 por hardware".
- [ ] Ponha conteúdo em movimento contínuo: vídeo 1080p60 em tela cheia ou um jogo.
- [ ] B assiste (próxima seção). No painel de A, a cada 10 s por 1 min, anote:
  - fonte (fps medido);
  - camadas `f`/`h`/`q` (resolução, fps, bitrate);
  - codificador, que deve mostrar `MediaFoundationVideoEncodeAccelerator (AMDh264Encoder)` e **hardware**;
  - limitação e ms/q;
  - CPU página/GPU.
- [ ] No Gerenciador de Tarefas > Desempenho > GPU, o gráfico "Video Encode" sobe com a transmissão (sem a GPU, o processo do app ficaria com a CPU alta).
- [ ] Repita compartilhando **uma janela** (o jogo ou o player) em vez da tela inteira.
- [ ] Repita com o codec **AV1** escolhido à mão. Nesta máquina ele sai em software (`libaom`): veja o fps e a CPU. Em GPU NVIDIA RTX 40 ou Intel Arc vale testar AV1 por hardware abrindo o app com `--enable-features=WebRtcAV1HWEncode,D3D12VideoEncodeAcceleratorL1T3` e anotar o codificador.

### Assistir sob demanda e camada máxima

- [ ] B entra na mesma voz. Na grade, a tela de A aparece como cartão "AO VIVO · Assistir", **sem vídeo**. No painel de A, as camadas ficam "ativa: não" e o upload perto de 0.
- [ ] B clica em **Assistir**. No painel de B (seção Voz), deve chegar 1920x1080 e o fps perto do da fonte. Anote também perdidos, descartados, congelamentos e jitter.
  - **Na primeira vez que alguém assiste**, a imagem pode começar em 360p/720p e levar até ~30 s para chegar a 1080p (subida da estimativa de banda, explicada acima). Anote esse tempo.
  - Em seguida, pare e assista de novo: deve chegar a 1080p em 1-2 s.
- [ ] Diminua bastante a janela de B: a resolução recebida continua 1920x1080 (antes caía para 720p).
- [ ] B clica em **Parar de assistir**: no painel de B, `screen_share` fica "não" e A volta a pausar as camadas.
- [ ] B sai da voz e assiste pelo botão "Assistir" da lista do canal (Modo Espectador): mesma resolução e fps.
- [ ] A compartilha com "Incluir áudio do sistema" e toca música. Em B, o áudio já vem ligado ao assistir, em estéreo, e o volume do player funciona. Desligue o áudio, pare de assistir e assista de novo: ele continua desligado (escolha salva).

### Voz

Use fones de ouvido.
- [ ] Configurações > Áudio > **Testar microfone**: você ouve a própria voz já processada. Compare com ruído de fundo real (ventilador, teclado):
  - **Desligada**: o ruído passa inteiro;
  - **Padrão**: reduz;
  - **Avançada (RNNoise)**: deve sumir quase todo, sem a voz ficar metálica.
- [ ] Ligue o **noise gate**. Ajuste o limite até a barra verde da fala passar da marca amarela e o ruído parado ficar abaixo dela. Fale frases curtas: o começo e o fim das palavras não podem ser cortados, e não pode haver estalo ao abrir e fechar.
- [ ] Em chamada (A fala, B ouve), troque o modo de supressão durante a fala: B ouve a mudança sem queda da voz.
- [ ] No painel de A (seção Voz, linha "microfone"), confira: 64 kbps de teto, **RED ativo**, eco/ruído/ganho conforme o modo e o processador ("rnnoise", "gate -NN dB").

### Dois PCs na mesma rede

Ainda não é possível com o servidor de desenvolvimento. O app só aceita `http://` para `localhost` (fora disso exige `https://`/`wss://`, regra de segurança da R2), e o Compose de dev escuta só em 127.0.0.1. O teste com dois PCs entra junto com a R3 (Caddy com TLS no servidor). Quando chegar a hora, repita as seções acima com A e B em PCs diferentes e anote também:
- jitter e perdas na rede de verdade;
- a CPU do PC mais fraco (decodificação);
- o codificador de uma GPU de outro fabricante (NVIDIA ou Intel).
