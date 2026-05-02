// tests/unit/tools/schema.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToStrictJsonSchema } from '../../../src/tools/schema.js';

describe('zodToStrictJsonSchema', () => {
  it('emits additionalProperties:false and lists every property in required (R3)', () => {
    const s = z.object({ path: z.string(), recursive: z.boolean() });
    const json = zodToStrictJsonSchema(s);
    expect(json).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'recursive'],
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
    });
  });

  it('refuses optional fields (R3 forbids partial schemas)', () => {
    const s = z.object({ path: z.string(), recursive: z.boolean().optional() });
    expect(() => zodToStrictJsonSchema(s)).toThrow(/optional/i);
  });

  it('handles nested objects and arrays', () => {
    const s = z.object({ items: z.array(z.object({ name: z.string() })) });
    const json = zodToStrictJsonSchema(s) as { properties: { items: unknown } };
    expect(json.properties.items).toEqual({
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    });
  });

  // Additional contract-coverage cases (lesson #5)

  it('handles number type', () => {
    const s = z.object({ count: z.number() });
    const json = zodToStrictJsonSchema(s);
    expect(json).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: { count: { type: 'number' } },
    });
  });

  it('handles boolean type explicitly', () => {
    const s = z.object({ flag: z.boolean() });
    const json = zodToStrictJsonSchema(s);
    expect(json).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['flag'],
      properties: { flag: { type: 'boolean' } },
    });
  });

  it('rejects unsupported Zod types (e.g. z.union)', () => {
    const s = z.object({ val: z.union([z.string(), z.number()]) });
    expect(() => zodToStrictJsonSchema(s)).toThrow(/Unsupported Zod schema/i);
  });

  it('rejects z.tuple as unsupported', () => {
    const s = z.object({ pair: z.tuple([z.string()]) });
    expect(() => zodToStrictJsonSchema(s)).toThrow(/Unsupported Zod schema/i);
  });
});
