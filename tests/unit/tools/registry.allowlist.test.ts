import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolDeniedByAllowlistError, ToolRegistry, type Tool } from '../../../src/tools/registry.js';

function mkTool(name: string, capability: 'coordination' | 'execution'): Tool<{ x: number }> {
  return {
    name,
    description: `${name} tool`,
    capability,
    inputSchema: z.object({ x: z.number() }),
    run: async (_input, _ctx) => `ran ${name}`,
  };
}

describe('ToolRegistry allowlist', () => {
  it('returns all tools when no allowlist set', () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    const names = r.getActiveTools().map((t) => t.name).sort();
    expect(names).toEqual(['germinate_spore', 'read_file', 'write_file']);
  });

  it('coordination tools always visible regardless of allowlist', () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    r.register(mkTool('spawn_subagent', 'coordination'));
    r.setActiveAllowlist([]);
    const names = r.getActiveTools().map((t) => t.name).sort();
    expect(names).toEqual(['germinate_spore', 'spawn_subagent']);
  });

  it('filters execution tools to those in the allowlist', () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.register(mkTool('grep', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    r.setActiveAllowlist(['read_file', 'grep']);
    const names = r.getActiveTools().map((t) => t.name).sort();
    expect(names).toEqual(['germinate_spore', 'grep', 'read_file']);
  });

  it('null allowlist resets to "no filter"', () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.setActiveAllowlist(['read_file']);
    expect(r.getActiveTools()).toHaveLength(1);
    r.setActiveAllowlist(null);
    expect(r.getActiveTools()).toHaveLength(2);
  });

  it('definitions() reflects the active filter', () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.register(mkTool('germinate_spore', 'coordination'));
    r.setActiveAllowlist(['read_file']);
    const names = r.definitions().map((d) => d.name).sort();
    expect(names).toEqual(['germinate_spore', 'read_file']);
  });

  it('invoke() gates a denied execution tool with ToolDeniedByAllowlistError (live mode)', async () => {
    // Defense-in-depth Case 4: even if the model hallucinates a tool_call for
    // write_file (or a future code path bypasses the schema-layer filter),
    // dispatch-layer gating must refuse the call.
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.setActiveAllowlist(['read_file']);
    await expect(r.invoke('write_file', { x: 42 })).rejects.toThrow(ToolDeniedByAllowlistError);
  });

  it('invoke() of an allowed execution tool succeeds (live mode)', async () => {
    const r = new ToolRegistry();
    r.register(mkTool('read_file', 'execution'));
    r.register(mkTool('write_file', 'execution'));
    r.setActiveAllowlist(['read_file']);
    const result = await r.invoke('read_file', { x: 42 });
    expect(result).toBe('ran read_file');
  });

  it('invoke() of a coordination tool succeeds even when allowlist is set', async () => {
    // Coordination tools are always allowed regardless of allowlist —
    // matches getActiveTools() semantics + R9 partition.
    const r = new ToolRegistry();
    r.register(mkTool('germinate_spore', 'coordination'));
    r.setActiveAllowlist([]);
    const result = await r.invoke('germinate_spore', { x: 1 });
    expect(result).toBe('ran germinate_spore');
  });

  it('invoke() with ctx.isHistoricalReplay=true bypasses the allowlist gate (rehydration mode)', async () => {
    // ConversationLog.readSession's rehydration path passes isHistoricalReplay:true
    // so historical tool_calls remain executable across allowlist changes.
    // Spec §2.3 resume-safety. NEVER pass this flag from a live runReactLoop turn.
    const r = new ToolRegistry();
    r.register(mkTool('write_file', 'execution'));
    r.setActiveAllowlist([]);
    const result = await r.invoke('write_file', { x: 42 }, { isHistoricalReplay: true });
    expect(result).toBe('ran write_file');
  });
});
