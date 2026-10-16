import { z } from 'zod';
import { HttpError } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, 'Dados inválidos', z.flattenError(result.error));
  }
  return result.data;
}
