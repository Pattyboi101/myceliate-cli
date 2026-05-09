import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { handleSporeTools } from '../../../src/cli/sporeSlashCommands.js';
import { type Tool, ToolRegistry } from '../../../src/tools/registry.js';

function mkTool(name: string, capability: 'coordination' | 'execution'): Tool<{ x: number }> {
  return {
    name,
    description: `${name} description`,
    capability,
    inputSchema: z.object({ x: z.number() }),
    run: async () => 'ok',
  };
}

describe('handleSporeTools', () => {
  it('returns full tool set when no spore is active', async () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    const out = await handleSporeTools({ tools: r, activeSpore: null });
    expect(out).toContain('read_file');
    expect(out).toContain('germinate_spore');
  });

  it('returns filtered set when allowlist is active', async () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    r.setActiveAllowlist(['read_file']);
    const out = await handleSporeTools({ tools: r, activeSpore: 'research' });
    expect(out).toContain('read_file');
    expect(out).toContain('germinate_spore');
    expect(out).not.toContain('write_file');
  });

  it('groups coordination vs execution in the output for clarity', async () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    const out = await handleSporeTools({ tools: r, activeSpore: null });
    // Output contains a section header for each capability — exact format
    // is up to the implementer; the test asserts grouping is present.
    expect(out).toMatch(/coordination/i);
    expect(out).toMatch(/execution/i);
  });

  it('shows a clear "no spore active" indicator when activeSpore is null', async () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    const out = await handleSporeTools({ tools: r, activeSpore: null });
    expect(out).toMatch(/no spore (active|pinned)/i);
  });
});
