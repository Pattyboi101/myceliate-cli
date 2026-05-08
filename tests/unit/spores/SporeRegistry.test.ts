// tests/unit/spores/SporeRegistry.test.ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';

const fixtures = resolve(__dirname, '../../fixtures/spores');

describe('SporeRegistry.discover', () => {
  it('discovers spores across all three tiers', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir: `${fixtures}/bundled`,
      userDir: `${fixtures}/user`,
      projectDir: `${fixtures}/project`,
    });
    const names = registry
      .list()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('resolves overrides — project beats user beats bundled', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir: `${fixtures}/bundled`,
      userDir: `${fixtures}/user`,
      projectDir: `${fixtures}/project`,
    });
    const alpha = registry.get('alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.tier).toBe('project');
    expect(alpha?.manifest.accent_color).toBe('#444444');
  });

  it('exposes only frontmatter descriptions in getDescriptions()', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir: `${fixtures}/bundled`,
      userDir: `${fixtures}/user`,
      projectDir: `${fixtures}/project`,
    });
    const descs = registry.getDescriptions();
    expect(descs).toHaveLength(3);
    for (const d of descs) {
      expect(d.name).toMatch(/^[a-z]+$/);
      expect(d.description.length).toBeLessThanOrEqual(200);
      expect(d.accent_color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('survives a malformed spore (logs warning, skips it)', async () => {
    // Bad spore at user/badspore: missing myceliate.yaml — registry must skip cleanly.
    const registry = await SporeRegistry.discover({
      bundledDir: `${fixtures}/bundled`,
      userDir: `${fixtures}/user`,
      projectDir: `${fixtures}/project`,
    });
    expect(registry.list().some((s) => s.name === 'badspore')).toBe(false);
  });

  it('returns empty registry when all tiers are missing', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir: '/nonexistent/bundled',
      userDir: '/nonexistent/user',
      projectDir: '/nonexistent/project',
    });
    expect(registry.list()).toEqual([]);
  });
});
