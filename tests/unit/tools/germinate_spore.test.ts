// tests/unit/tools/germinate_spore.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { readPin } from '../../../src/spores/pinFile.js';
import { createGerminateSporeTool } from '../../../src/tools/germinate_spore.js';

async function buildFixtureSpore(root: string, name: string, accent: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} sector.\n---\n${name} body.\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'myceliate.yaml'),
    `name: ${name}\ndescription: ${name} sector pack.\nversion: 1.0.0\naccent_color: "${accent}"\nagents: []\n`,
    'utf8',
  );
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'germinate-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('germinate_spore tool', () => {
  it('germinates a known spore: writes pin, emits event, appends body to system prompt', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildFixtureSpore(bundledDir, 'demo', '#abcdef');

    const registry = await SporeRegistry.discover({
      bundledDir,
      userDir: '/none',
      projectDir: '/none',
    });
    const events: Array<unknown> = [];
    let appendedBody: string | null = null;
    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: (e) => events.push(e),
      appendSystemPrompt: (s) => {
        appendedBody = s;
      },
    });

    const result = await tool.handler({ name: 'demo' });
    expect(result.ok).toBe(true);
    expect(appendedBody).toMatch(/demo body/);
    expect(await readPin(cwd)).toBe('demo');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'germination', spore: 'demo', accent_color: '#abcdef' }),
    );
  });

  it('rejects unknown spore name', async () => {
    const registry = await SporeRegistry.discover({
      bundledDir: '/none',
      userDir: '/none',
      projectDir: '/none',
    });
    const tool = createGerminateSporeTool({
      registry,
      cwd: workspace,
      emit: () => {},
      appendSystemPrompt: () => {},
    });
    const result = await tool.handler({ name: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown spore/);
  });
});
