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
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ task: z.string() }) },
      run: async () => 'ok',
    });
    r.register({
      name: 'edit',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ path: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
      run: async ({ msg }) => msg,
    });
    expect(() =>
      r.register({
        name: 'echo',
        description: 'd2',
        capability: 'execution',
        inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ path: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ a: z.string() }) },
      run: async () => 'ok',
    });
    r.register({
      name: 'tool2',
      description: 'd',
      capability: 'coordination',
      inputSchema: { kind: 'zod', zod: z.object({ b: z.string() }) },
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
      inputSchema: { kind: 'zod', zod: z.object({ n: z.coerce.number() }) },
      run: async (input) => {
        received = input.n;
        return 'ok';
      },
    });
    await r.invoke('capture', { n: '42' }); // string in
    expect(received).toBe(42); // coerced number out
  });

  // ---- T21: deregister + dual-schema ----

  it('deregister(name) removes the tool; subsequent getActiveTools excludes it', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
      run: async ({ msg }) => msg,
    });
    expect(r.getActiveTools().map((t) => t.name)).toContain('echo');
    r.deregister('echo');
    expect(r.getActiveTools().map((t) => t.name)).not.toContain('echo');
    await expect(r.invoke('echo', {})).rejects.toThrow(/Unknown tool/i);
  });

  it('deregister(name) is a no-op for unknown names (no throw)', () => {
    const r = new ToolRegistry();
    expect(() => r.deregister('nonexistent')).not.toThrow();
  });

  it('deregisterByPrefix(prefix) removes all matching tools and returns count', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'playwright_click',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ selector: z.string() }) },
      run: async () => 'ok',
    });
    r.register({
      name: 'playwright_navigate',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ url: z.string() }) },
      run: async () => 'ok',
    });
    r.register({
      name: 'bash',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ command: z.string() }) },
      run: async () => 'ok',
    });
    const count = r.deregisterByPrefix('playwright_');
    expect(count).toBe(2);
    const names = r.getActiveTools().map((t) => t.name);
    expect(names).not.toContain('playwright_click');
    expect(names).not.toContain('playwright_navigate');
    expect(names).toContain('bash');
  });

  it('Tool with json-schema kind: definitions() returns the raw JSON Schema verbatim', () => {
    const r = new ToolRegistry();
    const rawSchema = {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    };
    r.register({
      name: 'playwright_click',
      description: 'Click an element',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: rawSchema },
      run: async (_input) => 'clicked',
    });
    const def = r.definitions()[0];
    expect(def?.name).toBe('playwright_click');
    expect(def?.parameters).toEqual(rawSchema);
  });

  it('Tool with json-schema kind: invoke() passes rawInput through to run() without zod validation', async () => {
    const r = new ToolRegistry();
    let received: unknown;
    r.register({
      name: 'mcp_tool',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async (input) => {
        received = input;
        return 'ok';
      },
    });
    const rawInput = { arbitrary: 'data', num: 42 };
    await r.invoke('mcp_tool', rawInput);
    expect(received).toEqual(rawInput);
  });

  it('mixed registry (zod + json-schema): definitions() returns both shapes correctly', () => {
    const r = new ToolRegistry();
    const zodSchema = z.object({ msg: z.string() });
    const rawSchema = {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    };
    r.register({
      name: 'native_echo',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: zodSchema },
      run: async ({ msg }) => msg,
    });
    r.register({
      name: 'mcp_navigate',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: rawSchema },
      run: async () => 'ok',
    });
    const defs = r.definitions();
    expect(defs).toHaveLength(2);
    const echoDef = defs.find((d) => d.name === 'native_echo');
    const navDef = defs.find((d) => d.name === 'mcp_navigate');
    // zod kind produces strict schema
    expect(echoDef?.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['msg'],
      properties: { msg: { type: 'string' } },
    });
    // json-schema kind returns verbatim
    expect(navDef?.parameters).toEqual(rawSchema);
  });

  it('allowlist filter works with both schema kinds', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'native_tool',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ x: z.string() }) },
      run: async () => 'ok',
    });
    r.register({
      name: 'mcp_tool',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'ok',
    });
    r.setActiveAllowlist(['native_tool']);
    const names = r.getActiveTools().map((t) => t.name);
    expect(names).toContain('native_tool');
    expect(names).not.toContain('mcp_tool');
  });

  it('re-registering after deregister works (no "already registered" throw)', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
      run: async ({ msg }) => msg,
    });
    r.deregister('echo');
    expect(() =>
      r.register({
        name: 'echo',
        description: 'd2',
        capability: 'execution',
        inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
        run: async ({ msg }) => `new:${msg}`,
      }),
    ).not.toThrow();
    // Verify the re-registered tool is callable
    return expect(r.invoke('echo', { msg: 'hi' })).resolves.toBe('new:hi');
  });

  it('registering a duplicate name without prior deregister still throws (regression)', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
      run: async ({ msg }) => msg,
    });
    expect(() =>
      r.register({
        name: 'echo',
        description: 'd2',
        capability: 'execution',
        inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
        run: async ({ msg }) => msg,
      }),
    ).toThrow(/already registered/i);
  });
});
