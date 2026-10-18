# Plano v2: reestruturação

## 1. Objetivo
Transmissão de áudio e vídeo de alta qualidade (tela em 1080p60) para um grupo fechado de até 15 pessoas, com até 5 transmissões simultâneas.
- Cliente: executável Windows simples, que roda no PC de qualquer membro do grupo sem instalar mais nada.
- Servidor: PC com Ubuntu LTS na rede de casa, sem VPS.

## 2. Reaproveitamento da v1
| Parte da v1 | Destino na v2 | Motivo |
|---|---|---|
| `apps/desktop` | `frontend/` | Reaproveitar login, layout, provider de voz, Modo Espectador, compartilhamento de tela, painel de depuração e segurança. Remover o chat. |
| `apps/server` (Node) | Reescrito em Go em `backend/` | Binário único, baixo consumo, fácil de operar no Ubuntu. A v1 fica preservada na tag `v1-node`. |
| `packages/shared` | `contracts/openapi.yaml` | Contrato único que gera tipos para TypeScript e Go. |
| `infra/` | `infra/` adaptada | Configuração para IP público, TURN, Caddy e servidor caseiro. |
| Banco SQLite de desenvolvimento | Descartado | Só tinha dados de teste. |

## 3. Arquitetura alvo
```
[Cliente .exe (Electron)]
   |-- HTTPS (REST) + WSS (eventos) --> [Caddy :443] --> [backend Go] --> SQLite
   |-- WSS (sinalização) -------------> [Caddy :443] --> [LiveKit]
   '-- WebRTC (UDP 7882 / TCP 7881 / TURN) ------------> [LiveKit]

[LiveKit] -- webhooks assinados --> [backend Go]
```
Responsabilidades:
- LiveKit: só mídia (SFU). Recebe cada transmissão uma vez e repassa a cada espectador, sem recodificar.
- Backend Go: identidade, convites, canais, emissão de tokens, presença, menções e, no futuro, agenda.
- Frontend: interface, captura, codificação e reprodução.

## 4. Protocolos e rede

### WebRTC
- Sinalização: WebSocket com TLS. Cliente e servidor combinam codecs e caminhos de rede.
- ICE: testa caminhos (UDP direto, TCP, TURN) e escolhe o melhor.
- Mídia: SRTP (criptografado) sobre UDP.
- Controle de congestionamento: o emissor ajusta o bitrate conforme a rede (TWCC).
- Recuperação de perdas: retransmissão (NACK) no vídeo e FEC no Opus.
- Simulcast e SVC: o emissor manda camadas de qualidade, e o SFU entrega a cada espectador a camada que a rede dele aguenta.

### Por que não outros protocolos
- RTMP e HLS: latência de segundos.
- SRT: não roda nativo no Chromium.
- WebRTC é o único padrão de baixa latência nativo no Electron.

### UDP
Já em uso: a mídia trafega por UDP na porta 7882 (porta única multiplexada). TCP 7881 e TURN são reserva para redes que bloqueiam UDP. Funcionam, mas com qualidade inferior.

### FTP
Não usar. É antigo, sem criptografia por padrão e feito para transferir arquivos, não para tempo real. Se o app precisar trocar arquivos no futuro, a solução é upload por HTTPS para o backend.

### Gargalo principal: o codificador
Na v1, o H.264 saiu pelo OpenH264 (software). Em PCs mais fracos, isso consome muita CPU e derruba os 60 fps. A Fase Q mede `encoderImplementation` e `powerEfficientEncoder` nas estatísticas WebRTC e prioriza codificação por hardware (GPU), com fallback.

### Orçamento de banda (pior caso, qualidade máxima)
- Cada transmissor (upload da casa de quem transmite): ~10 Mbps (1080p60 + camadas de simulcast).
- Servidor, download: 5 transmissões x ~10 Mbps = ~50 Mbps.
- Servidor, upload: cada pessoa recebe uma transmissão em qualidade máxima por vez, então 15 x ~8 Mbps = ~120 Mbps. Reservar ~150 Mbps.
- Voz: desprezível perto do vídeo.

## 5. Servidor caseiro (Ubuntu LTS)
Requisitos:
- Cabo de rede (sem Wi-Fi), IP fixo na rede local (reserva DHCP no roteador), ligado o tempo todo. Nobreak recomendado.

Checklist de rede:
- CGNAT: comparar o IP da WAN no roteador com o IP público. Se forem diferentes (ou na faixa 100.64.0.0 a 100.127.255.255), a operadora usa CGNAT e ninguém de fora alcança o servidor. Solução: pedir IP público à operadora.
- IP público que muda: DDNS (domínio ou subdomínio gratuito que acompanha o IP).
- TLS obrigatório: o cliente bloqueia conexões sem criptografia fora do localhost. Caddy com Let's Encrypt.
- Redirecionamento de portas no roteador: 443/TCP, 80/TCP (emissão de certificado), 7881/TCP, 7882/UDP, 3478/UDP, 5349/TCP (TURN/TLS).
- NAT loopback: dentro de casa, acessar pelo domínio público pode falhar em alguns roteadores. Solução: DNS local ou endereço da LAN.
- Segurança: ufw liberando só as portas acima, SSH só pela rede local, atualizações automáticas e backup diário do SQLite.

## 6. Fases

### R0: reestruturação (sem funcionalidade nova)
- Criar a tag `v1-node` no commit atual e trabalhar na branch `v2`.
- Estrutura: `frontend/`, `backend/`, `infra/`, `contracts/`, `docs/`, com `README.md` em cada uma e na raiz.
- Mover `apps/desktop` para `frontend/`. Remover chat e Socket.IO do cliente. Copiar provisoriamente os tipos de `packages/shared` para `frontend/src/api/types.ts`.
- Remover `apps/server` e `packages/shared` (ficam preservados na tag).
- `backend/`: módulo Go com esqueleto (main, config por variáveis de ambiente, `GET /health`, slog, Dockerfile multi-stage e comandos de build, teste e lint documentados no README).
- Devolver comentários aos arquivos-chave do cliente: provider de voz, Modo Espectador, compartilhamento de tela, main e preload.
- Aceite: typecheck, lint e build do frontend; `go build`, `go vet` e `go test` do backend; READMEs presentes; commit.
- Observação: o app fica sem backend funcional até a R2. É esperado.

### R1a: backend Go, base e identidade
- `contracts/openapi.yaml` como fonte única; servidor gerado com `oapi-codegen`.
- SQLite (`modernc.org/sqlite`), migrações com `goose`, consultas com `sqlc`.
- Convites de uso único com expiração (comando de linha `invite create`), cadastro, login (JWT, senha com argon2id), seed com 7 canais de voz e o usuário admin.
- Emissão de token LiveKit com roles `voice` e `spectator`, com as mesmas permissões da v1.
- Segurança: rate limit nas rotas de autenticação, CORS restrito, limite de tamanho de corpo e timeouts no servidor HTTP.
- Testes unitários e de integração com `go test -race`; `golangci-lint` sem erros.
- Aceite: script que percorre convite, cadastro, login, canais e token, com o token validado no LiveKit.

### R1b: backend Go, tempo real
- Receptor de webhooks do LiveKit com assinatura verificada. Presença em memória: quem está em cada canal e quem está transmitindo. Reconciliação ao iniciar via RoomService.
- WebSocket autenticado para eventos de presença e menções (substitui o polling de 5 segundos da v1).
- Menções: "chamar atenção" de um usuário, com mensagem curta opcional, entregue em tempo real, com limite de frequência e sem persistência.
- Docker Compose local (Docker Desktop no Windows) com LiveKit e backend.
- Aceite: testes passando e demonstração com um cliente WebSocket de teste.

### R2: frontend conectado ao backend Go
- Tipos e cliente HTTP gerados do OpenAPI (`openapi-typescript` + `openapi-fetch`), substituindo `types.ts` provisório.
- Tela de configurações com o endereço do servidor, pedida na primeira execução e salva localmente.
- Presença e menções via WebSocket. Menção gera notificação do Windows com som. App pode ficar minimizado na bandeja.
- Aceite: duas instâncias locais funcionando como na v1 (voz, Modo Espectador, tela 1080p60) e com menções.

### Q: qualidade de áudio e vídeo (antes da R3)
Prioridade absoluta: qualidade de áudio e vídeo. Interface simples e funcional, sem investir em visual. Detalhes e números em `docs/medicoes.md`.
- Medição antes de mudar: painel de depuração do emissor por camada (resolução, fps e bitrate enviados, codec, `encoderImplementation`, `powerEfficientEncoder`, `qualityLimitationReason`), baseline registrado em `docs/medicoes.md` e repetido no fim (tabela antes e depois). Ponto de partida do teste real: pela sala de voz, 1280x720 a 1 fps e 21 kbps em VP8; pelo Modo Espectador, 1920x1080 a 27 fps e 7,08 Mbps em H.264 (OpenH264), sem perdas, jitter 3 ms.
- Codificador por hardware (M4): descobrir por que o H.264 sai pelo OpenH264 e fazer o Electron usar a GPU (NVIDIA, AMD ou Intel) quando houver, pelas flags do Chromium. Escolha automática do codec com aceleração (H.264 por hardware, depois AV1 por hardware, depois H.264 em software), mostrando no painel o codificador em uso.
- Resolução fixa: quem assiste recebe sempre a camada máxima, inclusive no próprio canal de voz (sem `adaptiveStream`). `degradationPreference: maintain-resolution` (em sobrecarga cai o fps, nunca a resolução). Camadas menores só quando a rede de quem assiste não comporta; comportamento documentado.
- Assistir sob demanda (estilo Discord): na voz, microfone e câmeras são assinados sozinhos; nenhum vídeo de tela é assinado nem mostrado como prévia. Quem está ao vivo aparece com botão "Assistir"; "Parar de assistir" cancela a assinatura. Dynacast ligado, com medição do upload do emissor sem espectador.
- Áudio: eco, ganho automático e supressão nativos ligados na voz; supressão Desligada / Padrão / Avançada (RNNoise local, via processador de trilha do `livekit-client`); noise gate com limite ajustável; Opus de voz a 64 kbps com RED e DTX; botão "Testar microfone". Áudio do stream continua estéreo e sem processamento.
- Executável de teste: `.exe` portátil (electron-builder) com endereço do servidor configurável; script e atalho "Iniciar teste" (confere o Docker, sobe o Compose de dev e abre duas instâncias). Endurecimento e assinatura continuam na R4.
- Testes de aceite do frontend em ambiente isolado (achado T1 da auditoria), com fonte falsa a 60 fps (T4).
- Aceite: testes e smoke test do app passando (teste de rede instável não conta); `docs/medicoes.md` com antes e depois, incluindo o codificador; checklist para teste com tela real e com dois PCs; commit e push.

### R3: servidor caseiro
- `infra/`: Compose de produção (LiveKit, backend, Caddy), `livekit.yaml` para IP público, TURN embutido, Caddyfile.
- Scripts para Ubuntu: instalação (Docker, ufw), deploy, atualização e backup do SQLite.
- Guia passo a passo em `docs/servidor.md`: IP fixo na LAN, CGNAT, DDNS, redirecionamento de portas, NAT loopback.
- O Claude gera scripts e guias; os comandos no servidor são executados pelo usuário via SSH.
- Aceite: cliente conectando pelo domínio público com TLS.

### R4: executável e teste com um amigo
- `electron-builder`: `.exe` portátil (sem instalação) e instalador NSIS, com ícone e versão.
- Endereço do servidor pré-preenchido, mas editável.
- Documentar o aviso do SmartScreen (sem certificado de assinatura de código).
- Aceite: um amigo em outra rede abre o app, cadastra com convite, fala e assiste em 1080p60.

### R5: otimização de mídia
- Codificador por hardware, escolha automática de codec, painel por camada e processamento de voz foram adiantados para a Fase Q.
- Ajuste fino de bitrate por preset, camadas de simulcast (ex.: 720p60 na camada média) e opção de 60 fps também fora da tela cheia.
- Subida até 1080p no primeiro espectador (~30 s medidos na Fase Q, pela estimativa de banda de quem transmite partindo de ~400 kbps): avaliar sondagem de banda e bitrate inicial.
- Testes com perda de pacotes simulada, na voz e na tela.
- Painel de depuração com perda, jitter e RTT do lado de quem envia.
- Aceite: relatório de medições com 5 transmissões simultâneas.

## 7. Futuro (não implementar agora)
- Agenda: eventos (assistir ou jogar juntos), convidados e lembretes. O backend agenda e avisa via WebSocket; o Windows mostra a notificação; o app fica na bandeja para receber.
- IA da agenda: só interpreta texto livre ("sábado 21h jogar X com fulano") e devolve título, data, hora e participantes. O usuário confirma antes de salvar. Opção gratuita preferida: modelo pequeno rodando no próprio servidor, com saída estruturada em JSON. Alternativa: plano gratuito de API externa (limites e uso de dados variam). O backend usa uma interface de "intérprete" trocável.
- Avisos por mensageiro: Telegram (bot gratuito) é o mais simples. WhatsApp exige a API oficial, geralmente paga.
- Captura de áudio por aplicativo (WASAPI process loopback, com módulo nativo).
- Mobile: fora do escopo por enquanto.
