// tests/unit/tools/spawn_subagent.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { isSubagentStep } from '../../../src/adapters/streamEvent.js';
import { bootTools } from '../../../src/runtime/bootTools.js';
import type { HitlGate } from '../../../src/security/hitlGate.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { createSpawnSubagentTool } from '../../../src/tools/spawn_subagent.js';
import type { Logger } from '../../../src/util/logger.js';

const fakeHitl: HitlGate = {
  requestApproval: async () => ({ kind: 'approve' }),
} as unknown as HitlGate;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

async function buildFixtureSporeWithPersona(
  root: string,
  name: string,
  agentName: string,
): Promise<void> {
  const dir = join(root, name);
  await mkdir(join(dir, 'agents', agentName), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} sector.\n---\nbody\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'myceliate.yaml'),
    `name: ${name}\ndescription: ${name} pack.\nversion: 1.0.0\naccent_color: "#abcdef"\nagents:\n  - ${agentName}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'agents', agentName, 'SKILL.md'),
    `---\nname: ${agentName}\ndescription: Test persona ${agentName}.\n---\nYou are ${agentName}.\n`,
    'utf8',
  );
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'spawn-sub-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('spawn_subagent tool', () => {
  it('rejects unknown persona', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const tool = createSpawnSubagentTool({
      registry,
      activeSpore: () => 'demo',
      spawn: async () => ({ ok: true, summary: 'unused' }),
    });
    const result = await tool.handler({ persona: 'nope', task: 'do thing' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown persona/);
  });

  it('invokes the spawn function with the persona skill body and task, returns summary', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    let received: { persona_skill: string; task: string } | null = null;
    const tool = createSpawnSubagentTool({
      registry,
      activeSpore: () => 'demo',
      spawn: async (req) => {
        received = req;
        return { ok: true, summary: `done by ${req.persona_name}` };
      },
    });
    const result = await tool.handler({ persona: 'real', task: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persona).toBe('real');
      expect(result.summary).toBe('done by real');
    }
    expect(received).not.toBeNull();
    expect(received?.task).toBe('hello');
    expect(received?.persona_skill).toMatch(/You are real/);
  });

  it('returns spawn errors transparently', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const tool = createSpawnSubagentTool({
      registry,
      activeSpore: () => 'demo',
      spawn: async () => ({ ok: false, error: 'sub-agent crashed', stderr_tail: 'segfault' }),
    });
    const result = await tool.handler({ persona: 'real', task: 'hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/crashed/);
    }
  });

  it('passes progress array through from spawn response to result', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const progressEntries = [
      { step: 0, durationMs: 100, model: 'deepseek-v4-flash' },
      { step: 1, durationMs: 200, model: 'deepseek-v4-flash' },
    ];
    const tool = createSpawnSubagentTool({
      registry,
      activeSpore: () => 'demo',
      spawn: async () => ({
        ok: true,
        summary: 'all done',
        progress: progressEntries,
      }),
    });
    const result = await tool.handler({ persona: 'real', task: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progress).toEqual(progressEntries);
    }
  });

  it('handles absent progress gracefully (undefined)', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const tool = createSpawnSubagentTool({
      registry,
      activeSpore: () => 'demo',
      spawn: async () => ({ ok: true, summary: 'done without progress' }),
    });
    const result = await tool.handler({ persona: 'real', task: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progress).toBeUndefined();
    }
  });
});

// ─── Orchestrator re-emission via bootTools emit seam ─────────────────────────
// These tests exercise the actual bootTools spawn_subagent wrapper end-to-end
// rather than inlining the emit loop. The _spawnFnOverride injection point
// replaces childProcessSpawn so no real subprocess is forked.

describe('spawn_subagent orchestrator re-emission', () => {
  it('emits one subagent_step event per progress entry via bootTools wrapper', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const progressEntries = [
      { step: 0, durationMs: 150, model: 'deepseek-v4-flash' },
      { step: 1, durationMs: 250, model: 'deepseek-v4-flash' },
    ];

    const emitted: StreamEvent[] = [];
    const { tools } = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      emit: (ev) => emitted.push(ev),
      activeSporeRef: () => 'demo',
      // Inject a mock spawn that returns the scripted progress without forking.
      _spawnFnOverride: async () => ({
        ok: true,
        summary: 'done',
        progress: progressEntries,
      }),
    });

    // Invoke the spawn_subagent tool via the registry (exercises the wrapper).
    await tools.invoke(
      'spawn_subagent',
      { persona: 'real', task: 'hello' },
      { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-id' },
    );

    const steps = emitted.filter(isSubagentStep);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      type: 'subagent_step',
      step: 0,
      durationMs: 150,
      model: 'deepseek-v4-flash',
    });
    expect(steps[1]).toEqual({
      type: 'subagent_step',
      step: 1,
      durationMs: 250,
      model: 'deepseek-v4-flash',
    });
  });

  it('emits no subagent_step events when progress is absent (bootTools wrapper)', async () => {
    const bundledDir = join(workspace, 'bundled');
    await mkdir(bundledDir, { recursive: true });
    await buildFixtureSporeWithPersona(bundledDir, 'demo', 'real');
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const emitted: StreamEvent[] = [];
    const { tools } = bootTools({
      hitl: fakeHitl,
      registry,
      logger: noopLogger,
      emit: (ev) => emitted.push(ev),
      activeSporeRef: () => 'demo',
      _spawnFnOverride: async () => ({ ok: true, summary: 'done' }),
    });

    await tools.invoke(
      'spawn_subagent',
      { persona: 'real', task: 'hello' },
      { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-id' },
    );

    expect(emitted.filter(isSubagentStep)).toHaveLength(0);
  });
});
