# frontend

Cliente desktop Windows: Electron (electron-vite) + React + TypeScript estrito + Tailwind. Gera um `.exe` na fase R4. Não contém segredos; o endereço do servidor é configurado na tela (fase R2).

## Comandos

```powershell
npm install
npm run dev          # app em modo desenvolvimento
npm run dev:second   # segunda instância (dados em .electron-second) para testar voz local
npm run typecheck
npm run lint
npm run build
npm run format
```

## Conteúdo

- `src/main/`: processo principal (janela, segurança, captura de tela, sessão cifrada com safeStorage)
- `src/preload/`: ponte mínima e tipada entre main e renderer
- `src/shared/`: contrato IPC entre main e renderer
- `src/renderer/`: interface React (voz, Modo Espectador, compartilhamento de tela, painel de depuração)
- `src/api/types.ts`: tipos provisórios copiados da v1; serão gerados de `contracts/openapi.yaml` na R2

Nesta fase o app não tem backend para conectar (volta na R1a/R2).
