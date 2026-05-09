import { describe, expect, it } from 'vitest';
import { bootTools } from '../../../src/runtime/bootTools.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { HitlGate } from '../../../src/security/hitlGate.js';
import type { Logger } from '../../../src/util/logger.js';
import type { Spore } from '../../../src/spores/Spore.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

const fakeHitl: HitlGate = {
  // Minimal stub — bootTools only passes it into createBashTool.
  requestApproval: async () => ({ kind: 'approve' }),
} as unknown as HitlGate;

function mkSpore(name: string, allowedTools: string[] | undefined): Spore {
  return {
    name,
    tier: 'bundled',
    dir: `/fake/${name}`,
    manifest: {
      name,
      description: 'desc',
      version: '1.0.0',
      accent_color: '#000000',
      keywords: [],
      agents: [],
      ...(allowedTools !== undefined ? { allowed_tools: allowedTools } : {}),
    },
    sectorFrontmatter: { name, description: 'desc' },
    sectorSkillPath: `/fake/${name}/SKILL.md`,
    personas: [],
    commands: [],
  };
}

describe('bootTools', () => {
  it('registers the standard execution + coordination tool set', () => {
    const registry = SporeRegistry.empty();
    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
    });
    const names = result.tools.byCapability('execution').map((t) => t.name).sort();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('grep');
    expect(names).toContain('list_dir');
    expect(names).toContain('bash');
    const coord = result.tools.byCapability('coordination').map((t) => t.name).sort();
    expect(coord).toEqual(['germinate_spore', 'spawn_subagent']);
  });

  it('setActiveSpore(name) propagates manifest allowed_tools to the registry', () => {
    const registry = SporeRegistry.fromList([mkSpore('locked', ['read_file', 'grep'])]);
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    result.setActiveSpore('locked');
    const visible = result.tools.getActiveTools().map((t) => t.name).sort();
    expect(visible).toEqual(['germinate_spore', 'grep', 'read_file', 'spawn_subagent']);
  });

  it('setActiveSpore(name) on a spore WITHOUT allowed_tools resets to unfiltered', () => {
    const registry = SporeRegistry.fromList([mkSpore('open', undefined)]);
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    result.setActiveSpore('open');
    const names = result.tools.getActiveTools().map((t) => t.name).sort();
    expect(names.length).toBeGreaterThanOrEqual(7); // all 5 execution + 2 coordination
  });

  it('setActiveSpore(null) resets to unfiltered', () => {
    const registry = SporeRegistry.fromList([mkSpore('locked', ['read_file'])]);
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    result.setActiveSpore('locked');
    expect(result.tools.getActiveTools().length).toBe(3); // read_file + 2 coord
    result.setActiveSpore(null);
    expect(result.tools.getActiveTools().length).toBeGreaterThanOrEqual(7);
  });

  it('setActiveSpore(name) on an unknown name warns + resets to unfiltered', () => {
    const events: Array<Record<string, unknown>> = [];
    const logger: Logger = { ...noopLogger, warn: (e) => events.push(e) };
    const registry = SporeRegistry.empty();
    const result = bootTools({ hitl: fakeHitl, registry, logger });
    result.setActiveSpore('nonexistent');
    expect(events.some((e) => e.event === 'set_active_spore_unknown')).toBe(true);
    expect(result.tools.getActiveTools().length).toBeGreaterThanOrEqual(7);
  });

  it('routes stale-pin warning to onUserVisibleWarning for the UI banner (Phase 23 Case 8)', () => {
    // Silent fail-open into a fully privileged execution surface is dangerous if
    // the user pinned a spore specifically to sandbox the orchestrator. The
    // onUserVisibleWarning callback is the contract for surfacing this in the UI.
    const visibleWarnings: string[] = [];
    const registry = SporeRegistry.empty();
    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      onUserVisibleWarning: (msg) => visibleWarnings.push(msg),
    });
    result.setActiveSpore('nonexistent');
    expect(visibleWarnings.some((m) => m.includes('nonexistent'))).toBe(true);
    // Falls back to unfiltered (existing behaviour).
    expect(result.tools.getActiveTools().length).toBeGreaterThanOrEqual(7);
  });

  it('drops unknown allowlist names with a warning, keeps known ones', () => {
    const events: Array<Record<string, unknown>> = [];
    const logger: Logger = { ...noopLogger, warn: (e) => events.push(e) };
    const registry = SporeRegistry.fromList([mkSpore('mixed', ['read_file', 'totally_fake_tool'])]);
    const result = bootTools({ hitl: fakeHitl, registry, logger });
    result.setActiveSpore('mixed');
    expect(
      events.some((e) => e.event === 'allowlist_unknown_tool' && e.tool === 'totally_fake_tool'),
    ).toBe(true);
    const names = result.tools.getActiveTools().map((t) => t.name).sort();
    expect(names).toContain('read_file');
    expect(names).not.toContain('totally_fake_tool');
  });

  it('strips coordination tool names from allowlist with warning', () => {
    const events: Array<Record<string, unknown>> = [];
    const logger: Logger = { ...noopLogger, warn: (e) => events.push(e) };
    const registry = SporeRegistry.fromList([mkSpore('badauth', ['read_file', 'germinate_spore'])]);
    const result = bootTools({ hitl: fakeHitl, registry, logger });
    result.setActiveSpore('badauth');
    expect(
      events.some(
        (e) => e.event === 'allowlist_coordination_tool_stripped' && e.tool === 'germinate_spore',
      ),
    ).toBe(true);
    // germinate_spore is still visible (coordination always visible) — but the warning
    // signals to the author that listing it had no effect.
    const names = result.tools.getActiveTools().map((t) => t.name).sort();
    expect(names).toContain('germinate_spore');
  });
});
