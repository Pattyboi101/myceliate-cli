// tests/unit/tools/spawn_subagent.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { createSpawnSubagentTool } from '../../../src/tools/spawn_subagent.js';

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
    const registry = await SporeRegistry.discover({
      bundledDir,
      userDir: '/none',
      projectDir: '/none',
    });

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
    const registry = await SporeRegistry.discover({
      bundledDir,
      userDir: '/none',
      projectDir: '/none',
    });

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
    const registry = await SporeRegistry.discover({
      bundledDir,
      userDir: '/none',
      projectDir: '/none',
    });

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
});
