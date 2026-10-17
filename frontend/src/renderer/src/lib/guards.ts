// Verificações de formato para dados que chegam de fora do código (rede, disco). Os tipos vêm do contrato
// gerado; estas funções só garantem em tempo de execução que o valor tem a forma que o tipo promete.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
