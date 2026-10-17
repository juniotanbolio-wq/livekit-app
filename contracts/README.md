# contracts

`openapi.yaml` é o contrato único entre frontend e backend. Tipos são gerados a partir dele (Go com `oapi-codegen`, TypeScript com `openapi-typescript`), nunca escritos à mão nos dois lados.

- Versão **OpenAPI 3.0.3** de propósito: é a que o `oapi-codegen` suporta de forma estável (3.1 não).
- Define `GET /health`, `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/channels` e `POST /api/livekit/token`. O WebSocket (`/ws`) e o webhook do LiveKit não são descritos em `paths` (o gerador não modela WebSocket), mas as **mensagens do WebSocket** estão em `components/schemas` (`Ws*`, `PresenceParticipant`, `ChannelPresence`), para os tipos Go e TypeScript saírem do mesmo lugar. O protocolo está em [../docs/protocolo-tempo-real.md](../docs/protocolo-tempo-real.md).
- Autenticação: esquema `bearerAuth` (JWT). O backend exige o token nas operações que declaram `security` no contrato.
- Mudou o contrato? Rode `backend\scripts\generate.ps1` e commite o código gerado (veja [../backend/README.md](../backend/README.md)). O frontend passa a gerar seus tipos daqui na R2.
