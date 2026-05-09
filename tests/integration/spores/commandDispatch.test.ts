import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dispatch } from '../../../src/cli/slashDispatcher.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { Logger } from '../../../src/util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

const BUNDLED = resolve(__dirname, '../../../spores');

describe('Phase 22 integration — bundled research:lit-review dispatch', () => {
  it('expands the lit-review body with the user-supplied topic', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'myc-int-'));
    try {
      const registry = await SporeRegistry.discover(
        { bundledDir: BUNDLED, userDir: '/nonexistent', projectDir: '/nonexistent' },
        { logger: noopLogger },
      );
      const result = await dispatch(
        '/research:lit-review microplastics in freshwater systems',
        { registry, activeSpore: 'research', cwd, logger: noopLogger },
      );
      expect(result.kind).toBe('expanded-prompt');
      if (result.kind !== 'expanded-prompt') throw new Error('type narrow');
      expect(result.body).toContain('microplastics in freshwater systems');
      expect(result.body).not.toContain('$ARGUMENTS');
      expect(result.body).toContain('5 sources');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
