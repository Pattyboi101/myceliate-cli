// tests/unit/spores/bootSpores.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootSpores } from '../../../src/spores/bootSpores.js';
import { createGerminateSporeTool } from '../../../src/tools/germinate_spore.js';

describe('bootSpores with --no-spore flag', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'no-spore-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns an empty registry when noSpore is true', async () => {
    const result = await bootSpores(cwd, true);
    expect(result.registry.list()).toEqual([]);
    expect(result.activeSpore).toBeNull();
    expect(result.germinatedSection).toBe('');
  });

  it('germinate_spore with empty registry returns unknown spore error', async () => {
    const result = await bootSpores(cwd, true);
    const tool = createGerminateSporeTool({
      registry: result.registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
    });
    const gerResult = await tool.handler({ name: 'solo-business' });
    expect(gerResult.ok).toBe(false);
    if (!gerResult.ok) {
      expect(gerResult.error).toMatch(/unknown spore/);
    }
  });
});
