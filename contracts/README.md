# contracts

`openapi.yaml` é o contrato único entre frontend e backend. Tipos são gerados a partir dele (Go com `oapi-codegen`, TypeScript com `openapi-typescript`), nunca escritos à mão nos dois lados.

- Versão **OpenAPI 3.0.3** de propósito: é a que o `oapi-codegen` suporta de forma estável (3.1 não).
- Define `GET /health`, `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/channels` e `POST /api/livekit/token`. O WebSocket (`/ws`) e o webhook do LiveKit não são descritos em `paths` (o gerador não modela WebSocket), mas as **mensagens do WebSocket** estão em `components/schemas` (`Ws*`, `PresenceParticipant`, `ChannelPresence`), para os tipos Go e TypeScript saírem do mesmo lugar. O protocolo está em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).
- `GET /health` devolve também `livekitUrl` (o endereço público do LiveKit): o cliente valida o servidor por ele e monta a CSP com o servidor e o LiveKit antes de qualquer login.
- Autenticação: esquema `bearerAuth` (JWT). O backend exige o token nas operações que declaram `security` no contrato.

Mudou o contrato? Regere os dois lados e commite o código gerado:

```powershell
cd backend;  pwsh -NoProfile -File scripts\generate.ps1   # internal/api (Go)
cd frontend; npm run generate                                                # src/generated (TypeScript)
```

`backend\scripts\check.ps1` e `npm run generate:check` falham se o código gerado commitado estiver desatualizado. No frontend, `src/generated/api.ts` traz os tipos (REST e `Ws*`) e `src/generated/contract.ts` os limites de validação (tamanho do nome, senha, convite e da mensagem de menção), para os formulários seguirem as mesmas regras do servidor.
