// tests/integration/spores/germinateSpawn.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { readPin } from '../../../src/spores/pinFile.js';
import { createGerminateSporeTool } from '../../../src/tools/germinate_spore.js';
import { createSpawnSubagentTool } from '../../../src/tools/spawn_subagent.js';

describe('integration: germinate -> spawn end-to-end', () => {
  let workspace: string;
  let bundledDir: string;
  let cwd: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'germinate-spawn-'));
    bundledDir = join(workspace, 'bundled');
    cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    // Build a fixture solo-business spore with one persona
    const dir = join(bundledDir, 'biz');
    await mkdir(join(dir, 'agents', 'ceo'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: biz\ndescription: Test biz spore.\n---\nBiz body.\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'myceliate.yaml'),
      'name: biz\ndescription: biz pack\nversion: 1.0.0\naccent_color: "#c5a45f"\nagents:\n  - ceo\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'agents', 'ceo', 'SKILL.md'),
      '---\nname: ceo\ndescription: Test CEO.\n---\nYou are the CEO.\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('full flow: germinate biz, spawn ceo, receive summary', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir,
      userDir: '/none',
      projectDir: '/none',
    });

    const events: Array<unknown> = [];
    let appended = '';
    let activeSporeName: string | null = null;

    const germinate = createGerminateSporeTool({
      registry,
      cwd,
      emit: (e) => events.push(e),
      appendSystemPrompt: (s) => {
        appended += s;
      },
    });
    const spawn = createSpawnSubagentTool({
      registry,
      activeSpore: () => activeSporeName,
      spawn: async (req) => {
        // Stubbed sub-agent: assert the request shape, return canned summary
        expect(req.persona_name).toBe('ceo');
        expect(req.persona_skill).toMatch(/You are the CEO/);
        expect(req.task).toBe('Plan Q3 priorities');
        return { ok: true, summary: 'Q3 priorities: ship, sell, hire.' };
      },
    });

    // Step 1: orchestrator decides to germinate
    const gerResult = await germinate.handler({ name: 'biz' });
    expect(gerResult.ok).toBe(true);
    if (gerResult.ok) activeSporeName = gerResult.spore;

    // Step 2: orchestrator spawns the CEO
    const spawnResult = await spawn.handler({ persona: 'ceo', task: 'Plan Q3 priorities' });
    expect(spawnResult.ok).toBe(true);
    if (spawnResult.ok) {
      expect(spawnResult.persona).toBe('ceo');
      expect(spawnResult.summary).toMatch(/Q3 priorities/);
    }

    // Step 3: side effects
    expect(await readPin(cwd)).toBe('biz');
    expect(appended).toMatch(/Biz body/);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'germination', spore: 'biz', accent_color: '#c5a45f' }),
    );
  });
});
