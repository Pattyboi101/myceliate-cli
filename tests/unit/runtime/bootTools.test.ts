import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { bootTools } from '../../../src/runtime/bootTools.js';
import type { McpLifecycle } from '../../../src/runtime/mcpLifecycle.js';
import type { HitlGate } from '../../../src/security/hitlGate.js';
import type { Spore } from '../../../src/spores/Spore.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { Logger } from '../../../src/util/logger.js';

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

// ─── McpLifecycle mock factory ────────────────────────────────────────────────

/**
 * Build a minimal McpLifecycle mock for bootTools unit tests.
 *
 * We avoid the real McpLifecycle to keep tests free of child-process plumbing.
 * The mock exposes:
 *   - `teardown`: spy so we can assert it was called with the right sporeName.
 *   - `setOnUnexpectedExit`: captures the handler so tests can fire it manually.
 *   - `fireUnexpectedExit`: test-only helper that invokes the captured handler.
 */
function makeMockMcpLifecycle() {
  let capturedHandler:
    | ((
        sporeName: string,
        exitInfo: { code: number | null; signal: NodeJS.Signals | null },
      ) => void)
    | undefined;

  const mock = {
    teardown: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
    setOnUnexpectedExit: vi.fn(
      (
        handler: (
          sporeName: string,
          exitInfo: { code: number | null; signal: NodeJS.Signals | null },
        ) => void,
      ) => {
        capturedHandler = handler;
      },
    ),
    fireUnexpectedExit(sporeName: string): void {
      if (!capturedHandler) throw new Error('No onUnexpectedExit handler registered');
      capturedHandler(sporeName, { code: 1, signal: null });
    },
  } as unknown as McpLifecycle & {
    fireUnexpectedExit: (sporeName: string) => void;
  };

  return mock;
}

describe('bootTools', () => {
  it('registers the standard execution + coordination tool set', () => {
    const registry = SporeRegistry.empty();
    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
    });
    const names = result.tools
      .byCapability('execution')
      .map((t) => t.name)
      .sort();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('grep');
    expect(names).toContain('list_dir');
    expect(names).toContain('bash');
    const coord = result.tools
      .byCapability('coordination')
      .map((t) => t.name)
      .sort();
    expect(coord).toEqual(['germinate_spore', 'spawn_subagent']);
  });

  it('setActiveSpore(name) propagates manifest allowed_tools to the registry', () => {
    const registry = SporeRegistry.fromList([mkSpore('locked', ['read_file', 'grep'])]);
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    result.setActiveSpore('locked');
    const visible = result.tools
      .getActiveTools()
      .map((t) => t.name)
      .sort();
    expect(visible).toEqual(['germinate_spore', 'grep', 'read_file', 'spawn_subagent']);
  });

  it('setActiveSpore(name) on a spore WITHOUT allowed_tools resets to unfiltered', () => {
    const registry = SporeRegistry.fromList([mkSpore('open', undefined)]);
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    result.setActiveSpore('open');
    const names = result.tools
      .getActiveTools()
      .map((t) => t.name)
      .sort();
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
    const names = result.tools
      .getActiveTools()
      .map((t) => t.name)
      .sort();
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
    const names = result.tools
      .getActiveTools()
      .map((t) => t.name)
      .sort();
    expect(names).toContain('germinate_spore');
  });

  // ─── T27: teardownMcpSpore closure ───────────────────────────────────────────

  it('returns teardownMcpSpore as a function in BootToolsResult', () => {
    const registry = SporeRegistry.empty();
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger });
    expect(typeof result.teardownMcpSpore).toBe('function');
  });

  it('teardownMcpSpore deregisters tools by prefix and calls mcpLifecycle.teardown', async () => {
    const registry = SporeRegistry.empty();
    const mcpLifecycle = makeMockMcpLifecycle();
    const emitted: StreamEvent[] = [];

    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      mcpLifecycle,
      emit: (ev) => emitted.push(ev),
    });

    // Manually register some fake tool wrappers with a spore prefix.
    result.tools.register({
      name: 'playwright_click',
      description: 'fake mcp wrapper',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'ok',
    });
    result.tools.register({
      name: 'playwright_navigate',
      description: 'fake mcp wrapper 2',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'ok',
    });

    // Tools visible before teardown.
    const namesBefore = result.tools.byCapability('execution').map((t) => t.name);
    expect(namesBefore).toContain('playwright_click');
    expect(namesBefore).toContain('playwright_navigate');

    await result.teardownMcpSpore('playwright');

    // Both wrappers deregistered.
    const namesAfter = result.tools.byCapability('execution').map((t) => t.name);
    expect(namesAfter).not.toContain('playwright_click');
    expect(namesAfter).not.toContain('playwright_navigate');

    // mcpLifecycle.teardown called with the spore name.
    expect(mcpLifecycle.teardown).toHaveBeenCalledOnce();
    expect(mcpLifecycle.teardown).toHaveBeenCalledWith('playwright');

    // system_message event emitted containing the removed count.
    const sysMsg = emitted.find((e) => e.type === 'system_message');
    expect(sysMsg).toBeDefined();
    expect((sysMsg as Extract<StreamEvent, { type: 'system_message' }>).text).toContain(
      'playwright',
    );
    expect((sysMsg as Extract<StreamEvent, { type: 'system_message' }>).text).toContain('2');
  });

  it('teardownMcpSpore wired as mcpLifecycle.onUnexpectedExit via setOnUnexpectedExit', async () => {
    const registry = SporeRegistry.empty();
    const mcpLifecycle = makeMockMcpLifecycle();
    const emitted: StreamEvent[] = [];

    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      mcpLifecycle,
      emit: (ev) => emitted.push(ev),
    });

    // setOnUnexpectedExit must have been called during bootTools().
    expect(mcpLifecycle.setOnUnexpectedExit).toHaveBeenCalledOnce();

    // Register a fake wrapper so we can observe deregistration.
    result.tools.register({
      name: 'crashy_do_thing',
      description: 'fake mcp wrapper',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'ok',
    });

    // Simulate unexpected exit by firing the captured handler.
    (mcpLifecycle as ReturnType<typeof makeMockMcpLifecycle>).fireUnexpectedExit('crashy');

    // Give the async teardownMcpSpore a microtask to run (the handler wraps in void).
    await new Promise((resolve) => setImmediate(resolve));

    // Wrapper deregistered as a side effect of the unexpected-exit path.
    const names = result.tools.byCapability('execution').map((t) => t.name);
    expect(names).not.toContain('crashy_do_thing');

    // system_message emitted on the unexpected-exit path too.
    const sysMsg = emitted.find((e) => e.type === 'system_message');
    expect(sysMsg).toBeDefined();
  });

  it('teardownMcpSpore works without mcpLifecycle (no-op lifecycle path)', async () => {
    // Pre-Phase-3 callers omit mcpLifecycle.  teardownMcpSpore must still deregister
    // and emit without throwing.
    const registry = SporeRegistry.empty();
    const emitted: StreamEvent[] = [];

    const result = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      emit: (ev) => emitted.push(ev),
    });

    result.tools.register({
      name: 'ghost_tool',
      description: 'pre-phase3',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'ok',
    });

    await expect(result.teardownMcpSpore('ghost')).resolves.toBeUndefined();

    const names = result.tools.byCapability('execution').map((t) => t.name);
    expect(names).not.toContain('ghost_tool');

    const sysMsg = emitted.find((e) => e.type === 'system_message');
    expect(sysMsg).toBeDefined();
  });

  it('existing bootTools tests remain compatible with new mcpLifecycle opt (no regression)', () => {
    // Callers that supply mcpLifecycle still get back a valid BootToolsResult.
    const registry = SporeRegistry.fromList([mkSpore('locked', ['read_file', 'grep'])]);
    const mcpLifecycle = makeMockMcpLifecycle();
    const result = bootTools({ hitl: fakeHitl, registry, logger: noopLogger, mcpLifecycle });

    result.setActiveSpore('locked');
    const visible = result.tools
      .getActiveTools()
      .map((t) => t.name)
      .sort();
    expect(visible).toEqual(['germinate_spore', 'grep', 'read_file', 'spawn_subagent']);
    expect(typeof result.teardownMcpSpore).toBe('function');
  });
});
