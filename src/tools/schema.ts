// src/tools/schema.ts
import { z } from 'zod';

export type JsonSchema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'array'; items: JsonSchema }
  | {
      type: 'object';
      additionalProperties: false;
      required: string[];
      properties: Record<string, JsonSchema>;
    };

export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    throw new Error(
      'Strict-mode tool schemas (R3) forbid optional fields. Make the field required, or use a separate tool variant.',
    );
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray)
    return { type: 'array', items: convert(schema.element as z.ZodTypeAny) };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = convert(v);
      required.push(k);
    }
    return { type: 'object', additionalProperties: false, required, properties };
  }
  throw new Error(`Unsupported Zod schema: ${schema.constructor.name}`);
}
