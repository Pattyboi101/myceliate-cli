import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleSporeList,
  handleSporePin,
  handleSporeUnpin,
} from '../../../src/cli/sporeSlashCommands.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { readPin } from '../../../src/spores/pinFile.js';
import type { Logger } from '../../../src/util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

let workspace: string;
let bundledDir: string;
let cwd: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'spore-slash-'));
  bundledDir = join(workspace, 'bundled');
  cwd = join(workspace, 'cwd');
  await mkdir(bundledDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(bundledDir, 'biz', 'agents', 'ceo'), { recursive: true });
  await writeFile(
    join(bundledDir, 'biz', 'SKILL.md'),
    '---\nname: biz\ndescription: biz sector.\n---\nbody\n',
    'utf8',
  );
  await writeFile(
    join(bundledDir, 'biz', 'myceliate.yaml'),
    `name: biz\ndescription: biz pack.\nversion: 1.0.0\naccent_color: "#abcdef"\nagents:\n  - ceo\n`,
    'utf8',
  );
  await writeFile(
    join(bundledDir, 'biz', 'agents', 'ceo', 'SKILL.md'),
    '---\nname: ceo\ndescription: ceo persona.\n---\nbody\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('spore slash commands', () => {
  it('/spore list prints the catalog with tier annotations', async () => {
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    const out = await handleSporeList({ registry });
    expect(out).toMatch(/biz/);
    expect(out).toMatch(/bundled/);
    expect(out).toMatch(/1 persona/);
  });

  it('/spore pin <name> writes the pin file', async () => {
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    const result = await handleSporePin({ registry, cwd, name: 'biz' });
    expect(result.ok).toBe(true);
    expect(await readPin(cwd, noopLogger)).toBe('biz');
  });

  it('/spore pin <unknown> rejects', async () => {
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    const result = await handleSporePin({ registry, cwd, name: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unknown/);
  });

  it('/spore unpin removes the pin file', async () => {
    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    await handleSporePin({ registry, cwd, name: 'biz' });
    const result = await handleSporeUnpin({ cwd });
    expect(result.ok).toBe(true);
    expect(await readPin(cwd, noopLogger)).toBeNull();
  });
});
