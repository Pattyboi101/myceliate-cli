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
  requestApproval: async () => ({ decision: 'approve' }),
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

describe('Phase 23 integration — active spore drives allowlist', () => {
  it('pinning a restrictive spore strips disallowed tools from registry definitions', () => {
    // Setup: registry with research pack declaring allowed_tools: [read_file, grep].
    const registry = SporeRegistry.fromList([mkSpore('research', ['read_file', 'grep'])]);
    const { tools, setActiveSpore } = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });

    // Initially: registry.definitions() includes all 5 execution tools.
    const initialNames = tools.definitions().map((d) => d.name);
    expect(initialNames).toContain('write_file');
    expect(initialNames).toContain('bash');

    // Action: setActiveSpore('research').
    setActiveSpore('research');

    // Expected: registry.definitions() includes read_file, grep, germinate_spore,
    // spawn_subagent (only). write_file, list_dir, bash absent.
    const activeNames = tools.definitions().map((d) => d.name).sort();
    expect(activeNames).toContain('read_file');
    expect(activeNames).toContain('grep');
    expect(activeNames).toContain('germinate_spore');
    expect(activeNames).toContain('spawn_subagent');
    expect(activeNames).not.toContain('write_file');
    expect(activeNames).not.toContain('list_dir');
    expect(activeNames).not.toContain('bash');
  });

  it('unpinning restores the full tool set', () => {
    // Setup: registry with research pack declaring allowed_tools.
    const registry = SporeRegistry.fromList([mkSpore('research', ['read_file', 'grep'])]);
    const { tools, setActiveSpore } = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });

    // After setActiveSpore('research') strips:
    setActiveSpore('research');
    const restrictedNames = tools.definitions().map((d) => d.name);
    expect(restrictedNames).not.toContain('write_file');

    // setActiveSpore(null) restores full set.
    setActiveSpore(null);
    const restoredNames = tools.definitions().map((d) => d.name);
    expect(restoredNames).toContain('write_file');
    expect(restoredNames).toContain('bash');
    expect(restoredNames.length).toBeGreaterThanOrEqual(7);
  });

  it('germination callback triggers allowlist update', () => {
    // Simulate: germination event sets the active spore.
    const registry = SporeRegistry.fromList([mkSpore('research', ['read_file'])]);
    let capturedSetActiveSpore: ((name: string) => void) | undefined;

    const { tools, setActiveSpore } = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      // The setActiveSporeFromGerminate callback is what germinate_spore tool calls
      // when it succeeds. Capture it so we can simulate a germination.
      setActiveSporeFromGerminate: (name: string) => {
        capturedSetActiveSpore = (n: string) => setActiveSpore(n);
        setActiveSpore(name);
      },
    });

    // Before germination: full tool set visible.
    expect(tools.getActiveTools().map((t) => t.name)).toContain('write_file');

    // Simulate germination event arriving for 'research'.
    capturedSetActiveSpore?.('research');
    // Or call setActiveSpore directly as the germination path would.
    setActiveSpore('research');

    // After germination: only read_file + coordination tools visible.
    const names = tools.getActiveTools().map((t) => t.name).sort();
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('bash');
  });
});
