# Auditoria — Fase A (antes da R3)

Data: 17/10/2026 · branch `v2` (depois da R2) · escopo: repositório inteiro, somente leitura (nenhum código alterado; as mudanças de processo da Fase A estão no `CLAUDE.md`, em `docs/notas-tecnicas.md` e nos scripts PowerShell).

## Como ler

| Severidade | Critério |
|---|---|
| **Crítico** | Explorável hoje com impacto alto, ou perda de dados certa. |
| **Alto** | Precisa estar resolvido antes de o servidor ir para a internet (R3), ou viola uma regra do projeto. |
| **Médio** | Segurança em profundidade, robustez ou desempenho; resolver em breve. |
| **Baixo** | Higiene, documentação, melhorias pequenas. |

Esforço: **P** (horas), **M** (1 dia), **G** (vários dias).

Ferramentas usadas: leitura do código, `npm audit`, `npm outdated`, `govulncheck` v1.9.0 (em contêiner), logs das execuções de aceite e um experimento isolado de rede Docker (contêiner, rede e porta próprios).

## Resumo

| Severidade | Quantidade |
|---|---|
| Crítico | 0 |
| Alto | 10 |
| Médio | 14 |
| Baixo | 15 |

| ID | Sev. | Área | Achado | Esforço |
|---|---|---|---|---|
| S1 | Alto | Segurança | Backend aceita segredos fracos e os textos de exemplo do `.env.example` | P |
| S2 | Alto | Segurança | Rate limit atrás do Caddy vira um balde só para o grupo inteiro | P |
| S3 | Alto | Segurança | Não há limite de tentativas por usuário (só por IP) | P |
| S4 | Alto | Segurança | Não há revogação de sessão nem remoção de usuário com efeito imediato | G |
| C1 | Alto | Confiabilidade | `e2e.ps1` instável na etapa de isolamento (causa raiz encontrada) | M |
| C2 | Alto | Confiabilidade | Não há backup do SQLite | M |
| T1 | Alto | Testes | `npm run e2e` usa o banco e o backend de desenvolvimento | M |
| M1 | Alto | Mídia | 1080p60 nunca foi medido com tela real nem com codificador por hardware | M (+ teste do usuário) |
| R1 | Alto | R3 | Chave LiveKit `devkey` e segredos de dev | P |
| R2 | Alto | R3 | Itens obrigatórios para ir à internet (lista abaixo) | G (é a própria R3) |
| S5 | Médio | Segurança | WebSocket continua aberto depois de o JWT expirar | P |
| S6 | Médio | Segurança | "Espectador só vê a tela" é garantido só pelo cliente | M |
| S7 | Médio | Segurança | Cadastro calcula argon2id antes de validar o convite | P |
| S9 | Médio | Segurança | Electron sem fuses e com DevTools no app empacotado (R4) | P |
| C3 | Médio | Confiabilidade | Migrações aplicadas ao subir sem backup prévio | P |
| C4 | Médio | Confiabilidade | Voz e espectador não voltam sozinhos depois de queda definitiva | M |
| C5 | Médio | Confiabilidade | App escondido na bandeja continua recebendo e decodificando vídeo | M |
| T2 | Médio | Testes | Usuários `e2e_*`/`dbg_*` no banco de dev e nenhum comando para removê-los | P (depois do S4) |
| T3 | Médio | Testes | Lógica crítica do cliente sem teste unitário | M |
| M3 | Médio | Mídia | Estatísticas insuficientes para escolher codificador por hardware | P |
| M4 | Médio | Mídia | Codificador por hardware não verificado (deu OpenH264 em software) | M |
| M5 | Médio | Mídia | Erros do capturador WGC no log | P (investigação) |
| K2 | Médio | Código | Faltam comentários em arquivos críticos (regra do projeto) | P |
| V1 | Médio | Versões | Electron 44.8.0 → 44.9.0 disponível | P |
| S8 | Baixo | Segurança | CORS de produção herdaria as origens de dev | P |
| S10 | Baixo | Segurança | `/health` segue redirecionamento; `%` malformado no `app://` | P |
| S11 | Baixo | Segurança | Token de voz com `canPublishData` sem uso | P |
| S12 | Baixo | Segurança | `govulncheck`: `cel-go` v0.29.0 (não alcançável) | P |
| C6 | Baixo | Confiabilidade | Tempo de encerramento do backend pode passar dos 10 s do `docker stop` | P |
| C7 | Baixo | Confiabilidade | Mais de 3 conexões do mesmo usuário geram "despejo" em laço | P |
| C8 | Baixo | Confiabilidade | Compose sem healthcheck e sem rotação de logs | P |
| T4 | Baixo | Testes | Fonte falsa a 20 fps: o aceite não exercita 60 fps | P |
| M2 | Baixo | Mídia | Painel mostra o fps pedido na captura, não o medido | P |
| M6 | Baixo | Mídia | Camada média do simulcast a 30 fps | P (decisão de mídia) |
| K1 | Baixo | Código | Restos da v1 (`HashIcon`, aliases na barra lateral) | P |
| K3 | Baixo | Código | Divergências pequenas entre contrato e implementação | P |
| K4 | Baixo | Código | READMEs a ajustar depois das correções | P |
| V2 | Baixo | Versões | TypeScript 6 com `overrides` no `openapi-typescript` | P |
| V3 | Baixo | Versões | Faixas `^`, imagens por tag sem digest, ferramenta `@latest` | P |

Já resolvido na própria Fase A (Parte 1): segredos do `e2e.ps1` vinham de `Get-Random` (previsível e sem repetição de caracteres) e passaram a usar `RandomNumberGenerator`; scripts padronizados para PowerShell 7.

---

## Segurança

### S1 · Alto · Backend aceita segredos fracos e os textos de exemplo
- **Arquivos:** `backend/internal/config/config.go` (`secret`), `backend/.env.example`, `infra/.env.example`.
- **Problema:** a validação só exige 32+ caracteres. O texto de exemplo `troque-por-um-segredo-aleatorio-com-32-ou-mais-caracteres` tem 57 e **passa**; `aaaa…` também passa. Quem copiar o `.env.example` para produção sem trocar sobe um servidor em que qualquer um que conheça o texto forja sessão de qualquer usuário (`JWT_SECRET`) e tokens do LiveKit com acesso total às salas (`LIVEKIT_API_SECRET`). `LIVEKIT_API_KEY=devkey` também é aceito.
- **Correção:** recusar a subida com (1) os textos de exemplo conhecidos, (2) baixa variedade (ex.: menos de 16 caracteres distintos ou um caractere ocupando mais de 25%), (3) `devkey` como nome de chave quando `LIVEKIT_PUBLIC_URL` não for localhost. Mensagem de erro com o comando para gerar (`pwsh: [Security.Cryptography.RandomNumberGenerator]::GetHexString(64,$true)` ou `openssl rand -base64 48`). Testes de config.

### S2 · Alto · Rate limit atrás do Caddy vira balde único
- **Arquivos:** `backend/internal/httpapi/middleware.go` (`clientIP`, `rateLimitAuth`), `backend/.env.example` (`TRUSTED_PROXIES`).
- **Problema:** a lógica está certa (só aceita `X-Forwarded-For` de proxies confiáveis, da direita para a esquerda), mas com o Caddy na frente e `TRUSTED_PROXIES` vazio todos os clientes aparecem com o IP do Caddy: 10 tentativas a cada 15 min **para o grupo inteiro** (um erro de senha de alguém bloqueia todos). Com `TRUSTED_PROXIES` amplo demais, o cabeçalho volta a ser forjável.
- **Correção (R3):** rede do Compose com sub-rede fixa e IP fixo para o Caddy; `TRUSTED_PROXIES` só com esse IP; Caddy sobrescrevendo (não acrescentando) `X-Forwarded-For`; aviso no log ao subir quando chega `X-Forwarded-For` de um par não confiável; teste de integração atrás de um proxy.

### S3 · Alto · Sem limite por usuário
- **Arquivos:** `middleware.go` (`rateLimitAuth`), `internal/service/service.go` (`Authenticate`).
- **Problema:** só há limite por IP. Um ataque distribuído (muitos IPs) contra uma conta não é limitado. E logins **bem-sucedidos** gastam o mesmo balde (família atrás do mesmo NAT se bloqueia).
- **Correção:** segundo limitador por nome de usuário normalizado, contando só **falhas** (ex.: 5 falhas/15 min por conta), com resposta 429 e `Retry-After`; o limite por IP passa a contar só falhas e cadastros. Atenção para não criar bloqueio deliberado de terceiros: limitar por conta só as falhas e liberar no primeiro login certo.

### S4 · Alto · Sem revogação de sessão nem remoção de usuário
- **Arquivos:** `internal/auth/token.go`, `internal/httpapi/middleware.go` (`identify`), `internal/realtime/ws.go`, `internal/livekit/token.go`, `cmd/server/commands.go`, `internal/db/migrations`.
- **Problema:** o JWT de sessão vale 7 dias e não há lista de revogação nem versão. Não existe comando para listar, desativar ou remover usuário. Mesmo apagando a linha no banco: `GET /api/channels` continua respondendo (só `/api/livekit/token` reconsulta o usuário), o WebSocket aberto continua recebendo presença e menções, a conexão LiveKit em curso continua, e o token LiveKit (6 h) permite entrar de novo. A única "revogação" hoje é trocar o `JWT_SECRET`, que derruba todos.
- **Correção:** coluna `session_version` (e `disabled_at`) em `users` + claim `ver` no JWT; `identify` confere usuário e versão no banco a cada requisição (15 usuários: custo desprezível); subcomandos `server user list|disable|enable|delete|logout`; o servidor revalida as conexões WebSocket a cada ~5 s (o CLI roda em outro processo, então a mudança chega pelo banco) e fecha com 1008, chamando `RoomService.RemoveParticipant` para a identidade de voz e a `#spectator` em todas as salas; `LIVEKIT_TOKEN_TTL` curto (ex.: 10 min; o LiveKit renova o token da sessão ativa sozinho). Testes de integração e passo no `e2e.ps1`.

### S5 · Médio · WebSocket sobrevive à expiração do JWT
- **Arquivos:** `internal/realtime/ws.go` (`authenticate`, `serve`).
- **Problema:** a autenticação só acontece na abertura; uma conexão aberta há dias continua depois do `exp`.
- **Correção:** guardar o `exp` do token na conexão e fechar com 1008 "sessão expirada" ao vencer (o cliente já trata como sessão encerrada). Coberto junto com o S4.

### S6 · Médio · "Espectador só vê a tela" depende do cliente
- **Arquivos:** `internal/livekit/token.go` (`grantFor`), `frontend/src/renderer/src/voice/spectator-subscriptions.ts`.
- **Problema:** o token `spectator` é oculto e tem `canSubscribe=true` para tudo; quem restringe a "só vídeo de tela" é o nosso cliente. Um cliente modificado com esse token pode assinar microfones e câmeras do canal **sem aparecer para ninguém** (escuta oculta). O grupo é fechado e por convite, mas o impacto em privacidade é alto. O LiveKit não tem permissão de assinatura por fonte no token.
- **Correção (mexe em decisão de mídia, discutir):** recomendo que cada publicador proteja as próprias trilhas: `localParticipant.setTrackSubscriptionPermissions(false, [...])` liberando microfone e câmera só para as identidades sem `#spectator` presentes na sala (atualizado a cada entrada), e a tela para todos. Alternativas: espectador visível ("assistindo") ou monitoramento no servidor (não há webhook de assinatura).

### S7 · Médio · argon2id antes de validar o convite
- **Arquivo:** `internal/service/service.go` (`Register`).
- **Problema:** o hash (64 MiB, ~100 ms) é calculado antes de conferir o convite, para não segurar o lock do SQLite. Qualquer um sem convite força esse custo (limitado a 4 simultâneos e pelo rate limit por IP).
- **Correção:** conferir antes, fora da transação, se o convite existe, não foi usado e não venceu (consulta barata, sem consumir); só então calcular o hash e fazer o consumo atômico como hoje.

### S8 · Baixo · CORS de produção com origens de dev
- **Arquivos:** `backend/.env.example`, `config.go` (padrão de `CORS_ORIGINS`).
- **Problema:** o padrão inclui `http://localhost:5173`. Impacto pequeno (sem cookies; o token fica no Electron), mas é superfície desnecessária.
- **Correção (R3):** `CORS_ORIGINS=app://desktop` no Compose de produção.

### S9 · Médio · Electron sem fuses e com DevTools no empacotado (R4)
- **Arquivos:** `frontend/src/main/index.ts`, futura configuração do `electron-builder`.
- **Problema:** o `.exe` aceitaria `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` e `--inspect`, e o menu padrão (escondido, mas ativo) abre o DevTools com Ctrl+Shift+I, expondo o token de sessão da memória. Exige acesso local, por isso Médio.
- **Correção (R4):** `@electron/fuses` (RunAsNode, NodeOptions, NodeCliInspect desligados; OnlyLoadAppFromAsar e integridade do asar ligados), `Menu.setApplicationMenu(null)` e `devTools: !app.isPackaged`.

### S10 · Baixo · Detalhes de entrada no processo principal
- **Arquivos:** `frontend/src/main/server-check.ts`, `frontend/src/main/security.ts` (`registerAppProtocol`).
- **Problema:** `net.fetch` do `/health` segue redirecionamentos para qualquer lugar; `decodeURIComponent` lança com `%` malformado e a resposta do `app://` fica sem tratamento.
- **Correção:** `redirect: 'error'` com mensagem clara; `try/catch` devolvendo 400.

### S11 · Baixo · Permissões do token de voz
- **Arquivo:** `internal/livekit/token.go`.
- **Situação:** permissões explícitas (bom: `nil` vale `true` no LiveKit), espectador oculto e sem publicar, sala por canal. Único excesso: `canPublishData=true` na voz, sem uso (não há chat nem dados).
- **Correção:** `canPublishData=false` (menor privilégio). Junto, avaliar `canPublishSources` limitando a microfone, câmera, tela e áudio da tela.

### S12 · Baixo · Dependências
- `npm audit`: **0 vulnerabilidades**.
- `govulncheck`: **0 vulnerabilidades alcançáveis** pelo código. Encontrou `GO-2026-6094` em `github.com/google/cel-go` v0.29.0 (dependência indireta; corrigida na v0.30.0; não chamada) e o aviso de módulo `GO-2026-5932` (`golang.org/x/crypto/openpgp`, que não usamos).
- **Correção:** subir `cel-go` para v0.30.0 (ou o `livekit/protocol` que já a traga) e incluir `govulncheck` (versão fixada) no `check.ps1`.

---

## Confiabilidade

### C1 · Alto · `e2e.ps1` instável — causa raiz
- **Arquivos:** `backend/scripts/e2e.ps1` (montagem da rede e etapa "Reconciliação periódica"), funções `New-Ws`/`Send-Ws`.
- **Sintoma:** na R2 uma execução falhou com `Exceção ao chamar "Wait"... Um ou mais erros` durante os 40 s de isolamento; a seguinte passou. Pelas regras novas isso não conta como aprovado.
- **Causa:** o teste cria o backend na rede padrão com a porta publicada (18080) e depois o liga à rede do teste; o isolamento é um `docker network disconnect` da rede do teste. A premissa é que a porta publicada continue passando pela rede padrão, **e o Docker não garante isso** para um contêiner em duas redes com a mesma prioridade de gateway. Experimento isolado (8 rodadas, Docker 29.8.2): com a segunda rede de nome anterior a `bridge`, 3 de 4 rodadas perderam a porta ao desligar a rede (conexões existentes **e** novas); com nome posterior, 4 de 4 sobreviveram, mas uma rodada fugiu do padrão (não é só ordem de nome). Na execução que falhou: o WebSocket do observador parou de responder aos pings (o servidor fechou conexões com 50 s exatos = 2 pings + 10 s), e o `Connect-Ws` seguinte não conseguiu abrir; como `New-Ws` faz `ConnectAsync().Wait()` sem `try`, a exceção abortou o script inteiro em vez de falhar um check.
- **Correção:** (1) não mexer na rede do backend: isolar por um proxy TCP (contêiner `socat`, imagem fixada) entre backend e LiveKit nos dois sentidos (`LIVEKIT_URL` e URL do webhook apontando para o proxy) e "cortar" com `docker pause`/`unpause` do proxy; alternativa mínima: `--network name=bridge,gw-priority=10` no `docker create` para fixar o caminho da porta. (2) `New-Ws`/`Send-Ws` com tratamento de erro (vira check que falha). (3) Validar com 10 execuções seguidas da etapa (ou do script) sem falha.

### C2 · Alto · Sem backup do SQLite
- **Arquivos:** `infra/`, `backend/cmd/server` (não há subcomando de backup; a imagem distroless não tem `sqlite3`).
- **Problema:** perder o volume `backend-data` apaga contas e convites; não há cópia nem procedimento de restauração.
- **Correção:** subcomando `server backup <arquivo>` (`VACUUM INTO`, consistente com o banco em uso), script da R3 com backup diário, rotação (ex.: 7 diários + 4 semanais), cópia para fora do servidor, teste de restauração documentado e backup automático antes de cada atualização.

### C3 · Médio · Migrações sem backup prévio
- **Arquivo:** `backend/internal/db/db.go` (`migrate`).
- **Problema:** o `goose Up` roda a cada subida; uma migração ruim (ou um binário antigo com banco mais novo) não tem volta automática.
- **Correção:** com o C2, backup automático quando houver migração pendente; documentar o rollback (`Down` existe nas migrações).

### C4 · Médio · Voz e espectador não voltam sozinhos
- **Arquivos:** `frontend/src/renderer/src/stores/voice.ts` (`handleDisconnected`), `stores/watch.ts`.
- **Problema:** se o LiveKit reiniciar ou a rede cair além do "resume" do SDK, o estado vai para `idle` com "A conexão de voz foi perdida. Entre no canal novamente". O WebSocket do backend reconecta sozinho; a mídia não.
- **Correção (decisão de UX):** nova tentativa automática com backoff para o canal em que a pessoa estava (e para o espectador), com indicador "Reconectando à voz...".

### C5 · Médio · App na bandeja continua consumindo vídeo
- **Arquivos:** `frontend/src/main/index.ts` (`backgroundThrottling: false`), `stores/watch.ts` (`setPlayerVisible`), `voice/VoiceProvider.tsx` (`adaptiveStream`).
- **Problema:** para manter a reconexão viva na bandeja desligamos o estrangulamento, e com isso o `document.visibilityState` fica sempre `visible`. O `adaptiveStream` (voz) e o "player visível" (espectador) não percebem a janela escondida: o app continua assinando e decodificando vídeo 1080p sem ninguém ver.
- **Correção:** o processo principal avisa o renderer (IPC) em `hide`/`show`/`minimize`/`restore`; o renderer chama `setPlayerVisible(false)` e pausa os vídeos (o áudio da voz continua).

### C6 · Baixo · Encerramento pode estourar o `docker stop`
- **Arquivo:** `backend/cmd/server/main.go`.
- **Problema:** `Shutdown` espera até 10 s e depois o hub fecha os WebSockets; o `docker stop` padrão dá 10 s antes do SIGKILL. A ordem (HTTP → rotinas de fundo → hub → banco) está certa.
- **Correção:** `stop_grace_period: 20s` no Compose de produção (ou `Shutdown` com 8 s).

### C7 · Baixo · "Despejo" em laço com mais de 3 conexões
- **Arquivos:** `internal/realtime/hub.go` (`register`), `frontend/src/renderer/src/lib/realtime.ts`.
- **Problema:** a 4ª conexão derruba a mais antiga (1008), que reconecta e derruba outra.
- **Correção:** o cliente não reconecta quando o motivo é "substituída por uma conexão mais nova"; mostra aviso.

### C8 · Baixo · Compose sem healthcheck nem rotação de logs
- **Arquivo:** `infra/docker-compose.yml`.
- **Correção (R3):** healthcheck (subcomando `server health` ou `/health` interno), `depends_on: condition: service_healthy`, `logging` com `max-size`/`max-file`.

---

## Testes

### T1 · Alto · `npm run e2e` usa o ambiente de desenvolvimento
- **Arquivo:** `frontend/scripts/e2e.mjs`.
- **Problema:** gera convites e cria usuários `e2e_*` no banco de dev, reinicia o contêiner `backend` de dev e gasta o rate limit de autenticação de dev (3 de 10 a cada 15 min). Viola a regra nova de ambiente isolado.
- **Correção:** subir um stack próprio como o `e2e.ps1`: LiveKit com `livekit.yaml` temporário (portas 17880, 17881/TCP e 17882/UDP, `node_ip` 127.0.0.1), backend em 18080 com segredos aleatórios, `AUTH_RATE_LIMIT` alto e volume descartável, seed com senha aleatória; o app aponta para `http://localhost:18080`; tudo removido no fim (também em caso de erro). Reaproveitar o proxy do C1 para o passo de reinício.

### T2 · Médio · Limpar usuários de teste do banco de dev
- **Situação:** o banco de dev tem cerca de 10 usuários `e2e_*` (um par por execução do aceite da R2) e 2 `dbg_*` (depuração). Não há comando de remoção.
- **Correção:** depois do S4, `docker compose exec backend /server user delete --prefix e2e_ --prefix dbg_` (com listagem e confirmação). Alternativa imediata: recriar o volume de dev (`docker compose down -v`, `up`, `seed`), que também apaga o admin e os convites de dev.

### T3 · Médio · Lógica crítica do cliente sem teste unitário
- **Arquivos:** `frontend/src/renderer/src/lib/realtime.ts`, `stores/presence.ts`.
- **Problema:** `seq` (salto, repetido), backoff, mapeamento de erros de menção e `applyEvent` só são exercitados pelo aceite completo, que não cobre o salto de `seq`.
- **Correção:** `vitest` (sem DOM) para `lib/` e `stores/`, com WebSocket falso e relógio controlado.

### T4 · Baixo · Aceite não exercita 60 fps
- **Arquivo:** `frontend/scripts/e2e.mjs`.
- **Correção:** `--use-fake-device-for-media-stream=fps=60` e registrar `qualityLimitationReason` e fps por camada no relatório do teste.

---

## Mídia

### Por que o teste deu ~20 fps
A camada de 1080p chegou ao espectador a ~20 fps com `limitação: none` e codificador `SimulcastEncoderAdapter (OpenH264 ×3)`. O motivo principal é a **fonte**: com `--use-fake-device-for-media-stream`, o Chromium troca a captura de tela por um padrão animado que roda, por padrão, a **20 fps**. O codificador não estava limitado (a razão seria `cpu` ou `bandwidth`). O painel mostrava "captura 60 fps" porque lê o valor pedido (`getSettings()`), não o medido (M2). Não há, portanto, medição real de 60 fps ainda.

### M1 · Alto · 1080p60 sem medição real
- **Problema:** a prioridade máxima do projeto (tela 1080p60) só foi testada com fonte falsa a 20 fps, codificação em software e as duas instâncias na mesma máquina. Seu teste manual da R2 ainda não trouxe números.
- **Roteiro de medição (você, com tela real):**
  1. Dois PCs na mesma rede (o ideal) ou um PC com duas instâncias (`npm run dev` + `npm run dev:second`) só para validar o fluxo.
  2. Na instância A: entrar na voz, compartilhar **a tela inteira** com um conteúdo em movimento contínuo (vídeo 60 fps em tela cheia ou jogo), qualidade 1080p 60, codec H.264.
  3. Abrir o painel (Ctrl+Shift+D) em A e anotar a cada 10 s, por 1 min: captura (resolução e fps), camadas `f`/`h`/`q` (resolução, fps, bitrate), `encoder` e `limitação`; e o uso de CPU/GPU no Gerenciador de Tarefas.
  4. Em B (Modo Espectador): resolução, fps e bitrate recebidos, perdidos e descartados.
  5. Repetir com VP9 e AV1, e com uma janela (não a tela inteira).
  6. Me mandar os números: com eles fechamos M4/M5 e a R5.
- **Correção no código (antes do teste):** M2 e M3, para o painel mostrar o que importa.

### M3 · Médio · Estatísticas insuficientes para escolher codificador
- **Arquivo:** `frontend/src/renderer/src/lib/rtc-stats.ts`.
- **Problema:** lê `encoderImplementation`, mas não `powerEfficientEncoder` (é ele que diz se é hardware), nem `qualityLimitationDurations`, `totalEncodeTime/framesEncoded` (ms por quadro), `framesPerSecond` da fonte (`media-source`) ou `availableOutgoingBitrate` (estimativa de banda). No receptor, `decoderImplementation` vem vazio no espectador: o Chrome só o expõe para páginas com permissão de captura.
- **Correção:** ler esses campos e mostrá-los no painel (base para a escolha automática de codec da R5).

### M4 · Médio · Codificador por hardware não verificado
- **Problema:** com H.264 em simulcast, o Chromium usa um codificador por camada (`SimulcastEncoderAdapter`) e, no teste, todos saíram em OpenH264 (software). Não sabemos se é limitação do ambiente (fonte falsa, máquina) ou se o hardware não está sendo usado com tela real. Codificar 1080p60 + duas camadas em software é o gargalo descrito no plano.
- **Correção:** medir com o M1; se continuar em software, testar VP9/AV1 SVC (uma codificação só) e as features do Chromium para codificação por hardware no Windows. É o trabalho da R5; não muda a decisão de mídia sem discussão.

### M5 · Médio · Erros do capturador WGC
- **Problema:** no log da instância que compartilhou apareceram `wgc_capturer_win.cc: Failed to start capture: -2147024809` (E_INVALIDARG). Com a fonte falsa a captura real não foi usada, então não dá para saber se, com tela real, o Chromium cai para DXGI ou GDI (o GDI não sustenta 60 fps em 1080p).
- **Correção:** no M1, conferir o log e o fps da fonte; se o WGC falhar, investigar a causa (cursor/borda, captura de janela minimizada) e as opções do Electron/Chromium.

### M2 · Baixo · Painel mostra o fps pedido
- **Arquivo:** `frontend/src/renderer/src/features/debug/DebugPanel.tsx`.
- **Correção:** mostrar o fps medido da fonte (`media-source.framesPerSecond`) ao lado do pedido.

### M6 · Baixo · Camada média a 30 fps
- **Arquivo:** `frontend/src/renderer/src/lib/screen-presets.ts`.
- **Situação:** no 1080p60, o simulcast tem 720p a 30 fps e 360p a 15 fps; quem cair da camada alta perde fluidez. Decisão de mídia: avaliar 720p60 na R5.

---

## Código

### K1 · Baixo · Restos da v1
- `HashIcon` (ícone de canal de texto) sem uso em `components/Icons.tsx`; `const Icon = SpeakerIcon` e `voiceChannels = channels` em `features/layout/Sidebar.tsx` (sobra do filtro texto/voz).

### K2 · Médio · Comentários faltando onde a regra exige
Arquivos de mídia, rede e segurança do Electron com zero ou quase nenhum comentário explicando o porquê: `stores/watch.ts` (Modo Espectador, 0), `lib/screen-presets.ts` (camadas e bitrates, 0), `lib/rtc-stats.ts` (0), `stores/voice.ts` (sequência de entrada, 1), `main/session-store.ts` (fallback em memória do safeStorage, 0), `features/stream/StreamPlayer.tsx` (0) e `features/stream/useLiveChannels.ts` (0). O backend está bem comentado.

### K3 · Baixo · Contrato × implementação
- Respostas reais não descritas no OpenAPI: 403 (origem fora do CORS), 405 e 404 genéricos.
- Regras escritas à mão em vez de geradas: `PUBLIC_PATHS` no cliente (`lib/api.ts`) repete a `security` do contrato; `usernameRE` (seed) e `MaxMentionRunes` no Go repetem limites do contrato.
- **Correção:** documentar as respostas comuns; gerar `PUBLIC_PATHS` em `src/generated/contract.ts`; no Go, ler os limites da spec embutida ou testar que coincidem.

### K4 · Baixo · READMEs a ajustar
- O README da raiz ainda não cita a Fase A; `frontend/README.md` e `infra/README.md` descrevem o aceite usando o Compose de dev (muda com o T1); `docs/protocolo-tempo-real.md` diz que menção é só para quem está em voz (muda na Parte 3).

---

## Versões

### V1 · Médio · Electron 44.8.0 → 44.9.0
Atualização de patch disponível (versões de patch do Electron costumam trazer correções de segurança do Chromium). Atualizar e rodar o aceite.

### V2 · Baixo · TypeScript 6 com `overrides`
- `openapi-typescript` 7.13 declara `typescript ^5`; hoje um `overrides` o faz usar o TS 6 do projeto (funciona, mas é combinação não suportada). Já existe TS 7.0.2, ainda sem suporte do `typescript-eslint`.
- **Correção recomendada:** dar ao `openapi-typescript` o seu próprio `typescript@5.9.x` aninhado (via `overrides`), mantendo o projeto no TS 6; o `generate:check` prova que a saída não mudou. Não ir para o TS 7 agora.

### V3 · Baixo · Fixação de versões
- `package.json` com faixas `^` (o `package-lock.json` fixa; usar `npm ci` em scripts e na R4).
- Imagens Docker por tag sem digest: `golang:1.27`, `golang:1.27-alpine`, `gcr.io/distroless/static-debian12:nonroot`, `livekit/livekit-server:v1.13.10`, `golangci/golangci-lint:v2.15.0`.
- **Correção:** fixar digests no Compose de produção (R3) e versões das ferramentas chamadas por linha de comando (`govulncheck@v1.9.0`, não `@latest`).

---

## Preparação para a R3

### R1 · Alto · Chave LiveKit `devkey` e segredos de dev
- Hoje: nome de chave fixo `devkey` (Compose, backend e `webhook.api_key` do `livekit.yaml`), segredo do `infra/.env` de dev.
- **Correção:** em produção, nome de chave aleatório (ex.: `API` + 12 caracteres) e segredo de 32+ bytes gerados pelo script de instalação, nunca versionados; `livekit.yaml` de produção gerado no deploy (o `webhook.api_key` precisa citar o nome da chave); validação do S1 recusando `devkey`.

### R2 · Alto · O que precisa mudar para ir à internet
| Item | Hoje | Na R3 |
|---|---|---|
| TLS | backend e LiveKit em HTTP/WS | Caddy na 443 com Let's Encrypt; `LIVEKIT_PUBLIC_URL=wss://…`; o cliente já recusa `http`/`ws` fora do localhost |
| Backend exposto | 127.0.0.1:8080 | sem porta publicada; só via Caddy (`/api`, `/health`, `/ws`); `/webhooks/livekit` **não** exposto (LiveKit chama pela rede interna) |
| Proxy | — | `TRUSTED_PROXIES` com o IP fixo do Caddy (S2) |
| CORS | origens de dev | `app://desktop` (S8) |
| LiveKit rede | `node_ip` 127.0.0.1, `use_external_ip: false` | IP público/DDNS (`use_external_ip` ou `node_ip`), portas 7881/TCP e 7882/UDP |
| TURN | desligado | TURN embutido (3478/UDP, 5349/TLS com certificado) para redes que bloqueiam UDP |
| Roteador / ufw | — | 80, 443, 7881/TCP, 7882/UDP, 3478/UDP, 5349/TCP; SSH só na LAN; atualizações automáticas |
| Usuários | sem gestão | CLI do S4 (listar, desativar, remover, encerrar sessões) |
| Backup | nenhum | C2 + C3 |
| Operação | — | healthchecks, `stop_grace_period`, rotação de logs (C6, C8), procedimento de atualização com imagens por digest (V3), relógio sincronizado (expiração de JWT) |
| Salas | `max_participants: 30` | limitar ao tamanho do grupo (ex.: 20) |
| Segredos | dev | gerados pelo script, validados (S1, R1), nunca exibidos |

---

## Mudança de decisão registrada para a Parte 3
**Menções para qualquer usuário conectado ao WebSocket**, inclusive quem está só na bandeja (hoje: só quem está num canal de voz). Exige mudança no protocolo: o snapshot passa a trazer a lista de usuários conectados e há eventos `user_online`/`user_offline` com `seq` (ou uma mensagem com a lista inteira a cada mudança, já que o grupo é pequeno). O cliente ganha uma lista "Online" na barra lateral com o botão de chamar atenção. Contrato, backend (hub conta conexões por usuário), cliente, testes e documentação mudam juntos.
