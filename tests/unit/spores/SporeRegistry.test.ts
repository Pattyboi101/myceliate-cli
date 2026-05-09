// tests/unit/spores/SporeRegistry.test.ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { Logger } from '../../../src/util/logger.js';

const fixtures = resolve(__dirname, '../../fixtures/spores');

function fakeLogger(): { logger: Logger; warn: (e: Record<string, unknown>) => void; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const warn = (e: Record<string, unknown>): void => {
    calls.push(e);
  };
  const noop = (_e: Record<string, unknown>): void => {};
  return {
    logger: { debug: noop, info: noop, warn, error: noop, flush: async () => {} },
    warn,
    calls,
  };
}

describe('SporeRegistry.discover', () => {
  it('discovers spores across all three tiers', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: `${fixtures}/user`, projectDir: `${fixtures}/project` },
      { logger },
    );
    const names = registry
      .list()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma', 'research']);
  });

  it('resolves overrides — project beats user beats bundled', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: `${fixtures}/user`, projectDir: `${fixtures}/project` },
      { logger },
    );
    const alpha = registry.get('alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.tier).toBe('project');
    expect(alpha?.manifest.accent_color).toBe('#444444');
  });

  it('exposes only frontmatter descriptions in getDescriptions()', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: `${fixtures}/user`, projectDir: `${fixtures}/project` },
      { logger },
    );
    const descs = registry.getDescriptions();
    expect(descs).toHaveLength(4);
    for (const d of descs) {
      expect(d.name).toMatch(/^[a-z]+$/);
      expect(d.description.length).toBeLessThanOrEqual(200);
      expect(d.accent_color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('survives a malformed spore (logs warning, skips it)', async () => {
    const { logger } = fakeLogger();
    // Bad spore at user/badspore: missing myceliate.yaml — registry must skip cleanly.
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: `${fixtures}/user`, projectDir: `${fixtures}/project` },
      { logger },
    );
    expect(registry.list().some((s) => s.name === 'badspore')).toBe(false);
  });

  it('returns empty registry when all tiers are missing', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: '/nonexistent/bundled', userDir: '/nonexistent/user', projectDir: '/nonexistent/project' },
      { logger },
    );
    expect(registry.list()).toEqual([]);
  });
});

describe('SporeRegistry.empty', () => {
  it('returns a registry with zero spores', () => {
    const registry = SporeRegistry.empty();
    expect(registry.list()).toEqual([]);
    expect(registry.getDescriptions()).toEqual([]);
    expect(registry.get('anything')).toBeUndefined();
  });
});

describe('SporeRegistry Logger DI', () => {
  it('emits a structured warn event when an override replaces a lower-tier spore', async () => {
    const { logger, calls } = fakeLogger();
    const registry = await SporeRegistry.discover(
      {
        bundledDir: `${fixtures}/bundled`,
        userDir: `${fixtures}/user`,
        projectDir: `${fixtures}/project`,
      },
      { logger },
    );
    expect(registry.get('alpha')?.tier).toBe('project');
    const overrideEvents = calls.filter((c) => c.event === 'spore_override');
    expect(overrideEvents.length).toBeGreaterThan(0);
    // alpha exists in bundled+user+project, so there are two override events.
    // Assert that the final override (user→project) is present.
    const evt = overrideEvents.find((c) => c.name === 'alpha' && c.to_tier === 'project');
    expect(evt).toBeDefined();
    expect(evt).toMatchObject({ name: 'alpha', from_tier: 'user', to_tier: 'project' });
  });

  it('emits a structured warn event when a malformed spore is skipped', async () => {
    const { logger, calls } = fakeLogger();
    await SporeRegistry.discover(
      {
        bundledDir: `${fixtures}/bundled`,
        userDir: `${fixtures}/user`,
        projectDir: `${fixtures}/project`,
      },
      { logger },
    );
    const skipEvents = calls.filter((c) => c.event === 'spore_load_skipped');
    expect(skipEvents.some((c) => c.name === 'badspore')).toBe(true);
  });
});
