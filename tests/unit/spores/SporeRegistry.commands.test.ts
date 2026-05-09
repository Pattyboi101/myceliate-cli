import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { Logger } from '../../../src/util/logger.js';

const fixtures = resolve(__dirname, '../../fixtures/spores');

function fakeLogger(): { logger: Logger; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const noop = (_e: Record<string, unknown>): void => {};
  const warn = (e: Record<string, unknown>): void => {
    calls.push(e);
  };
  return {
    logger: { debug: noop, info: noop, warn, error: noop, flush: async () => {} },
    calls,
  };
}

describe('SporeRegistry commands discovery', () => {
  it('discovers commands/*.md files alongside agents', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger },
    );
    const research = registry.get('research');
    expect(research).toBeDefined();
    const names = research?.commands.map((c) => c.name).sort();
    expect(names).toContain('lit-review');
    expect(names).toContain('methodology-check');
  });

  it('parses argument-hint when present', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger },
    );
    const research = registry.get('research');
    const lr = research?.commands.find((c) => c.name === 'lit-review');
    expect(lr?.argumentHint).toBe('<topic>');
    const mc = research?.commands.find((c) => c.name === 'methodology-check');
    expect(mc?.argumentHint).toBeUndefined();
  });

  it('ignores subdirectories under commands/', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger },
    );
    const research = registry.get('research');
    expect(research?.commands.find((c) => c.name === 'ignored')).toBeUndefined();
  });

  it('warns and skips when filename basename does not match frontmatter name', async () => {
    const { logger, calls } = fakeLogger();
    await SporeRegistry.discover(
      {
        bundledDir: `${fixtures}/bundled-mismatch`,
        userDir: '/nonexistent',
        projectDir: '/nonexistent',
      },
      { logger },
    );
    expect(calls.some((c) => c.event === 'command_filename_mismatch')).toBe(true);
  });

  it('warns and skips when frontmatter is malformed', async () => {
    const { logger, calls } = fakeLogger();
    await SporeRegistry.discover(
      {
        bundledDir: `${fixtures}/bundled-malformed`,
        userDir: '/nonexistent',
        projectDir: '/nonexistent',
      },
      { logger },
    );
    expect(calls.some((c) => c.event === 'command_load_skipped')).toBe(true);
  });

  it('returns empty commands array when commands/ directory is absent', async () => {
    const { logger } = fakeLogger();
    const registry = await SporeRegistry.discover(
      { bundledDir: `${fixtures}/bundled`, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger },
    );
    // alpha has no commands/ directory
    const noCommands = registry.list().find((s) => s.name === 'alpha');
    expect(noCommands?.commands).toEqual([]);
  });
});
