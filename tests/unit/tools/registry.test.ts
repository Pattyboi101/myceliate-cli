// tests/unit/tools/registry.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/tools/registry.js';

describe('ToolRegistry', () => {
  it('registers a tool and exposes its V4-strict definition', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'Echo input',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    const def = r.definitions()[0];
    expect(def?.name).toBe('echo');
    expect(def?.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['msg'],
      properties: { msg: { type: 'string' } },
    });
  });

  it('partitions tools by capability for mutual-exclusion enforcement (R9)', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'spawn',
      description: 'd',
      capability: 'coordination',
      inputSchema: z.object({ task: z.string() }),
      run: async () => 'ok',
    });
    r.register({
      name: 'edit',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ path: z.string() }),
      run: async () => 'ok',
    });
    expect(r.byCapability('coordination').map((t) => t.name)).toEqual(['spawn']);
    expect(r.byCapability('execution').map((t) => t.name)).toEqual(['edit']);
  });

  it('validates input via the registered Zod schema before invoking run', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    await expect(r.invoke('echo', { msg: 123 })).rejects.toThrow();
  });

  // Additional contract-coverage cases (lesson #5)

  it('register rejects duplicate names', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    expect(() =>
      r.register({
        name: 'echo',
        description: 'd2',
        capability: 'execution',
        inputSchema: z.object({ msg: z.string() }),
        run: async ({ msg }) => msg,
      }),
    ).toThrow(/already registered/i);
  });

  it('invoke throws on unknown tool', async () => {
    const r = new ToolRegistry();
    await expect(r.invoke('nonexistent', {})).rejects.toThrow(/Unknown tool/i);
  });

  it('invoke passes the run() result through unchanged', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => `result:${msg}`,
    });
    const result = await r.invoke('echo', { msg: 'hello' });
    expect(result).toBe('result:hello');
  });

  it('byCapability returns [] for an unused capability', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'edit',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ path: z.string() }),
      run: async () => 'ok',
    });
    expect(r.byCapability('coordination')).toEqual([]);
  });

  it('definitions() returns one entry per registered tool', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'tool1',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ a: z.string() }),
      run: async () => 'ok',
    });
    r.register({
      name: 'tool2',
      description: 'd',
      capability: 'coordination',
      inputSchema: z.object({ b: z.string() }),
      run: async () => 'ok',
    });
    expect(r.definitions()).toHaveLength(2);
    const names = r.definitions().map((d) => d.name);
    expect(names).toContain('tool1');
    expect(names).toContain('tool2');
  });

  it('run() receives the Zod-parsed value, not the raw input (coercion contract)', async () => {
    const r = new ToolRegistry();
    let received: unknown;
    r.register({
      name: 'capture',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ n: z.coerce.number() }),
      run: async (input) => {
        received = input.n;
        return 'ok';
      },
    });
    await r.invoke('capture', { n: '42' }); // string in
    expect(received).toBe(42); // coerced number out
  });
});
