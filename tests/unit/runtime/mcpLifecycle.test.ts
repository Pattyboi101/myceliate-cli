// tests/unit/runtime/mcpLifecycle.test.ts
//
// Integration-style unit tests for McpLifecycle using the real fake-server.mjs
// fixture from T22.  Tests run against the actual SDK transport — no mocking of
// the child_process layer.  This means they're slightly slower (~100ms per test)
// but faithfully test the lifecycle semantics we care about.
//
// Ordering of imports after the describe block ensures Vitest ESM caching doesn't
// cause stale-module issues across test runs.

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpLifecycleOpts } from '../../../src/runtime/mcpLifecycle.js';
import { McpLifecycle, McpLifecycleSpawnError } from '../../../src/runtime/mcpLifecycle.js';
import { noopLogger } from '../../../src/util/noopLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_SERVER = join(__dirname, '../../fixtures/mcp/fake-server.mjs');

// Unique temp dir per test run so log files don't collide.
const TEST_LOGS_DIR = join(tmpdir(), `mcpLifecycle-test-${Date.now()}`);

/**
 * Build a minimal Spore-like object with mcp_server configured.
 * The Spore type is imported from src/spores/Spore.ts — we use `as any` only
 * for the fields not relevant to McpLifecycle (tier, dir, sectorFrontmatter, etc.).
 */
function makeSpore(
  name: string,
  envOverrides: Record<string, string> = {},
  callTimeoutMs?: number,
) {
  return {
    name,
    tier: 'user' as const,
    dir: '/fake/dir',
    manifest: {
      name,
      description: 'test spore',
      version: '1.0.0',
      accent_color: '#c5a45f',
      keywords: [],
      agents: [],
      mcp_server: {
        command: process.execPath,
        args: [FAKE_SERVER],
        env: {
          ...(process.env as Record<string, string>),
          ...envOverrides,
        },
        sensitive_tools: [],
        ...(callTimeoutMs !== undefined ? { call_timeout_ms: callTimeoutMs } : {}),
      },
    },
    sectorFrontmatter: { name, description: 'test', trigger: '' } as never,
    sectorSkillPath: '/fake/SKILL.md',
    personas: [],
    commands: [],
  };
}

function makeSporeWithoutMcpServer(name: string) {
  return {
    name,
    tier: 'user' as const,
    dir: '/fake/dir',
    manifest: {
      name,
      description: 'test spore',
      version: '1.0.0',
      accent_color: '#c5a45f',
      keywords: [],
      agents: [],
      // no mcp_server field
    },
    sectorFrontmatter: { name, description: 'test', trigger: '' } as never,
    sectorSkillPath: '/fake/SKILL.md',
    personas: [],
    commands: [],
  };
}

function makeOpts(overrides: Partial<McpLifecycleOpts> = {}): McpLifecycleOpts {
  return {
    logsDir: TEST_LOGS_DIR,
    callTimeoutMs: 5000,
    logger: noopLogger,
    ...overrides,
  };
}

describe('McpLifecycle', () => {
  let lifecycle: McpLifecycle;

  beforeEach(() => {
    lifecycle = new McpLifecycle(makeOpts());
  });

  afterEach(async () => {
    // Always tear everything down so child processes don't outlive the test.
    await lifecycle.teardownAll().catch(() => {});
  });

  // ─── spawn resolves + getActive ──────────────────────────────────────────────

  describe('spawn(spore)', () => {
    it('resolves with a working client; getActive returns same instance', async () => {
      const spore = makeSpore('playwright');
      const client = await lifecycle.spawn(spore as never);

      expect(client).toBeDefined();
      expect(typeof client.listTools).toBe('function');
      expect(typeof client.callTool).toBe('function');
      expect(typeof client.close).toBe('function');

      const active = lifecycle.getActive('playwright');
      expect(active).toBe(client); // exact same reference
    }, 10_000);

    it('rejects with McpLifecycleSpawnError when mcp_server is absent from manifest', async () => {
      const spore = makeSporeWithoutMcpServer('no-server');
      await expect(lifecycle.spawn(spore as never)).rejects.toThrow(McpLifecycleSpawnError);
    }, 5_000);
  });

  // ─── Idempotency ─────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('second spawn of same spore returns the SAME client (no second child spawned)', async () => {
      const spore = makeSpore('playwright');

      const client1 = await lifecycle.spawn(spore as never);
      const client2 = await lifecycle.spawn(spore as never);

      expect(client1).toBe(client2); // exact same reference — idempotent
      // listActive should still show just one entry
      expect(lifecycle.listActive()).toEqual(['playwright']);
    }, 15_000);
  });

  // ─── Multi-active ────────────────────────────────────────────────────────────

  describe('multi-active', () => {
    it('two distinct spores → two distinct clients; listActive returns both', async () => {
      const spore1 = makeSpore('playwright');
      const spore2 = makeSpore('postgres');

      const [client1, client2] = await Promise.all([
        lifecycle.spawn(spore1 as never),
        lifecycle.spawn(spore2 as never),
      ]);

      expect(client1).not.toBe(client2); // distinct clients
      expect(lifecycle.getActive('playwright')).toBe(client1);
      expect(lifecycle.getActive('postgres')).toBe(client2);

      const active = lifecycle.listActive();
      expect(active).toContain('playwright');
      expect(active).toContain('postgres');
      expect(active).toHaveLength(2);
    }, 15_000);
  });

  // ─── teardown — clean SIGTERM ────────────────────────────────────────────────

  describe('teardown', () => {
    it('SIGTERMs cleanly; process exits within grace period', async () => {
      const spore = makeSpore('playwright');
      await lifecycle.spawn(spore as never);

      // Should resolve cleanly without hanging
      await expect(lifecycle.teardown('playwright')).resolves.toBeUndefined();

      // Entry removed from active map
      expect(lifecycle.getActive('playwright')).toBeUndefined();
      expect(lifecycle.listActive()).not.toContain('playwright');
    }, 10_000);

    it('escalates to SIGKILL when FAKE_TRAP_SIGTERM=1', async () => {
      const spore = makeSpore('stubborn', { FAKE_TRAP_SIGTERM: '1' });
      await lifecycle.spawn(spore as never);

      // With a short grace window, lifecycle should escalate to SIGKILL and still resolve
      const lifecycleShortGrace = new McpLifecycle(makeOpts({ teardownGraceMs: 500 }));
      await lifecycleShortGrace.spawn(spore as never);

      await expect(lifecycleShortGrace.teardown('stubborn')).resolves.toBeUndefined();
      expect(lifecycleShortGrace.getActive('stubborn')).toBeUndefined();
    }, 10_000);

    it('teardown of unknown spore is a no-op (does not throw)', async () => {
      await expect(lifecycle.teardown('nonexistent')).resolves.toBeUndefined();
    }, 5_000);
  });

  // ─── teardownAll ─────────────────────────────────────────────────────────────

  describe('teardownAll', () => {
    it('shuts down multiple concurrent spores; listActive becomes empty', async () => {
      const spore1 = makeSpore('playwright');
      const spore2 = makeSpore('postgres');
      const spore3 = makeSpore('mysql');

      await Promise.all([
        lifecycle.spawn(spore1 as never),
        lifecycle.spawn(spore2 as never),
        lifecycle.spawn(spore3 as never),
      ]);

      expect(lifecycle.listActive()).toHaveLength(3);

      await expect(lifecycle.teardownAll()).resolves.toBeUndefined();

      expect(lifecycle.listActive()).toHaveLength(0);
    }, 20_000);
  });

  // ─── Stdio routing (log file) ────────────────────────────────────────────────

  describe('stdio routing', () => {
    it('log file exists at .myceliate/logs/mcp-<name>.log after spawn', async () => {
      const { existsSync } = await import('node:fs');

      const spore = makeSpore('playwright');
      await lifecycle.spawn(spore as never);

      const expectedLog = join(TEST_LOGS_DIR, 'mcp-playwright.log');
      expect(existsSync(expectedLog)).toBe(true);
    }, 10_000);
  });

  // ─── onUnexpectedExit bridge ─────────────────────────────────────────────────

  describe('onUnexpectedExit bridge', () => {
    it('fires configured opts.onUnexpectedExit callback when server crashes; entry removed from map', async () => {
      const onUnexpectedExit = vi.fn();
      const lc = new McpLifecycle(makeOpts({ onUnexpectedExit }));

      const spore = makeSpore('crasher', { FAKE_EXIT_AFTER_TOOL_CALL: '1' });
      const client = await lc.spawn(spore as never);

      // Trigger the crash: fake-server exits after tools/call
      await client.callTool('echo', { x: 'trigger' }).catch(() => {});

      // Wait for transport onclose to propagate
      await new Promise<void>((r) => setTimeout(r, 200));

      expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
      expect(onUnexpectedExit).toHaveBeenCalledWith(
        'crasher',
        expect.objectContaining({ code: null, signal: null }),
      );

      // Entry should be removed from active map
      expect(lc.getActive('crasher')).toBeUndefined();
      expect(lc.listActive()).not.toContain('crasher');

      await lc.teardownAll().catch(() => {});
    }, 10_000);

    it('explicit teardown does NOT trigger onUnexpectedExit', async () => {
      const onUnexpectedExit = vi.fn();
      const lc = new McpLifecycle(makeOpts({ onUnexpectedExit }));

      const spore = makeSpore('normal');
      await lc.spawn(spore as never);

      await lc.teardown('normal');

      // Allow any async settle
      await new Promise<void>((r) => setTimeout(r, 200));

      expect(onUnexpectedExit).not.toHaveBeenCalled();
    }, 10_000);
  });

  // ─── Per-spore call_timeout_ms override ──────────────────────────────────────

  describe('per-spore callTimeoutMs override', () => {
    it('per-spore call_timeout_ms takes precedence over lifecycle default', async () => {
      // Spore sets a very short timeout (200ms); server responds after 500ms → should timeout
      const spore = makeSpore(
        'slow-server',
        { FAKE_CALL_DELAY_MS: '500' },
        200, // call_timeout_ms in manifest
      );

      // Lifecycle default is generous — 10s — so if the per-spore override isn't
      // respected the test would hang for 500ms then pass; with the override it
      // should reject quickly with a timeout.
      const lc = new McpLifecycle(makeOpts({ callTimeoutMs: 10_000 }));
      const client = await lc.spawn(spore as never);

      await expect(client.callTool('echo', { x: 'slow' })).rejects.toThrow(/timeout/i);

      await lc.teardownAll().catch(() => {});
    }, 15_000);
  });

  // ─── listActive ──────────────────────────────────────────────────────────────

  describe('listActive', () => {
    it('returns empty array when no spores are active', () => {
      expect(lifecycle.listActive()).toEqual([]);
    });

    it('returns only currently active spore names', async () => {
      const spore1 = makeSpore('playwright');
      const spore2 = makeSpore('postgres');

      await lifecycle.spawn(spore1 as never);
      await lifecycle.spawn(spore2 as never);

      expect(lifecycle.listActive().sort()).toEqual(['playwright', 'postgres']);

      await lifecycle.teardown('playwright');

      expect(lifecycle.listActive()).toEqual(['postgres']);
    }, 15_000);
  });
});
