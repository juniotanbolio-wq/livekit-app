// Gerado por scripts/generate-api.mjs a partir de contracts/openapi.yaml.
// Não edite à mão: altere o contrato e rode `npm run generate`.

// Limites de validação do contrato, para o cliente validar com as mesmas regras do servidor.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const INVITE_CODE_MIN_LENGTH = 8;
export const INVITE_CODE_MAX_LENGTH = 64;
export const MENTION_MESSAGE_MAX_LENGTH = 140;
export const USERNAME_PATTERN = new RegExp("^[a-zA-Z0-9_.-]+$");
