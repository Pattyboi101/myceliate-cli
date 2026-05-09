import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, type DispatchResult } from '../../../src/cli/slashDispatcher.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import type { Logger } from '../../../src/util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

async function fixtureRegistry(): Promise<{ registry: SporeRegistry; cleanup: () => Promise<void> }> {
  // Build a tmp tier with one pack + two commands on disk.
  const root = await mkdtemp(join(tmpdir(), 'myc-disp-'));
  const packDir = join(root, 'research');
  await mkdir(join(packDir, 'commands'), { recursive: true });
  await writeFile(
    join(packDir, 'myceliate.yaml'),
    [
      'name: research',
      'description: Research.',
      'version: 1.0.0',
      'accent_color: "#4a90c4"',
      'agents: []',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(packDir, 'SKILL.md'),
    '---\nname: research\ndescription: Research.\n---\nbody',
    'utf8',
  );
  await writeFile(
    join(packDir, 'commands', 'lit-review.md'),
    [
      '---',
      'name: lit-review',
      'description: Lit review.',
      'argument-hint: <topic>',
      '---',
      '',
      'Produce a lit review on: $ARGUMENTS',
    ].join('\n'),
    'utf8',
  );
  // A command without $ARGUMENTS (for the implicit-append test)
  await writeFile(
    join(packDir, 'commands', 'methodology-check.md'),
    [
      '---',
      'name: methodology-check',
      'description: Check methodology.',
      '---',
      '',
      'Check the methodology described below.',
    ].join('\n'),
    'utf8',
  );
  const registry = await SporeRegistry.discover(
    { bundledDir: root, userDir: '/nonexistent', projectDir: '/nonexistent' },
    { logger: noopLogger },
  );
  return { registry, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

describe('slashDispatcher.dispatch', () => {
  it('returns no-match for non-slash input', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch('hello world', { registry, activeSpore: null, cwd: '/tmp', logger: noopLogger });
      expect(r.kind).toBe('no-match');
    } finally {
      await cleanup();
    }
  });

  it('returns no-match for /spore (handled by orchestrator built-ins, not dispatcher)', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch('/spore list', { registry, activeSpore: null, cwd: '/tmp', logger: noopLogger });
      // Pack-command regex does not match /spore (no colon). Falls through.
      expect(r.kind).toBe('no-match');
    } finally {
      await cleanup();
    }
  });

  it('expands a pack command body and substitutes $ARGUMENTS', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch(
        '/research:lit-review graphene oxide membranes',
        { registry, activeSpore: 'research', cwd: '/tmp', logger: noopLogger },
      );
      expect(r.kind).toBe('expanded-prompt');
      if (r.kind !== 'expanded-prompt') throw new Error('type narrow');
      expect(r.body).toContain('Produce a lit review on: graphene oxide membranes');
      expect(r.body).not.toContain('$ARGUMENTS');
    } finally {
      await cleanup();
    }
  });

  it('appends \\n\\n + raw args when $ARGUMENTS placeholder is absent', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch(
        '/research:methodology-check foo bar',
        { registry, activeSpore: 'research', cwd: '/tmp', logger: noopLogger },
      );
      expect(r.kind).toBe('expanded-prompt');
      if (r.kind !== 'expanded-prompt') throw new Error('type narrow');
      expect(r.body).toContain('Check the methodology described below.');
      expect(r.body).toMatch(/\n\nfoo bar$/);
    } finally {
      await cleanup();
    }
  });

  it('refuses with active-spore message when invoked pack is not the active spore', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch(
        '/research:lit-review topic',
        { registry, activeSpore: null, cwd: '/tmp', logger: noopLogger },
      );
      expect(r.kind).toBe('orchestrator-output');
      if (r.kind !== 'orchestrator-output') throw new Error('type narrow');
      expect(r.text).toMatch(/pin it first/i);
      expect(r.text).toContain('/spore pin research');
    } finally {
      await cleanup();
    }
  });

  it('reports pack-not-found', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch(
        '/nonexistent:foo',
        { registry, activeSpore: null, cwd: '/tmp', logger: noopLogger },
      );
      expect(r.kind).toBe('orchestrator-output');
      if (r.kind !== 'orchestrator-output') throw new Error('type narrow');
      expect(r.text).toContain('no spore named "nonexistent"');
    } finally {
      await cleanup();
    }
  });

  it('reports command-not-found', async () => {
    const { registry, cleanup } = await fixtureRegistry();
    try {
      const r = await dispatch(
        '/research:nonexistent',
        { registry, activeSpore: 'research', cwd: '/tmp', logger: noopLogger },
      );
      expect(r.kind).toBe('orchestrator-output');
      if (r.kind !== 'orchestrator-output') throw new Error('type narrow');
      expect(r.text).toContain('has no command "nonexistent"');
    } finally {
      await cleanup();
    }
  });

  it('logs a structured slash_dispatched event for audit', async () => {
    const events: Array<Record<string, unknown>> = [];
    const auditLogger: Logger = {
      ...noopLogger,
      info: (e) => events.push(e),
    };
    const { registry, cleanup } = await fixtureRegistry();
    try {
      await dispatch(
        '/research:lit-review topic',
        { registry, activeSpore: 'research', cwd: '/tmp', logger: auditLogger },
      );
      const dispatched = events.find((e) => e.event === 'slash_dispatched');
      expect(dispatched).toMatchObject({
        event: 'slash_dispatched',
        pack: 'research',
        command: 'lit-review',
      });
    } finally {
      await cleanup();
    }
  });
});
