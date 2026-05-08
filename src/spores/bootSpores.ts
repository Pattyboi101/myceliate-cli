// src/spores/bootSpores.ts
// Extracted from src/index.ts so tests can import this without triggering main().
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SporeRegistry } from './SporeRegistry.js';
import { readPin } from './pinFile.js';
import { parseSkillFrontmatter } from './skillFrontmatter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Bundled spores live at <install-root>/spores/ (one level up from dist/src/)
const BUNDLED_SPORES_DIR = resolve(HERE, '../../spores');
const USER_SPORES_DIR = resolve(homedir(), '.myceliate', 'skills');

export interface SporeBootResult {
  activeSpore: string | null;
  registry: SporeRegistry;
  germinatedSection: string;
}

export async function bootSpores(cwd: string, noSpore: boolean): Promise<SporeBootResult> {
  const projectSporesDir = resolve(cwd, '.myceliate', 'skills');
  if (noSpore) {
    // TODO(v1.4): SporeRegistry.empty() factory instead of /nonexistent paths
    return {
      activeSpore: null,
      registry: await SporeRegistry.discover({
        bundledDir: '/nonexistent',
        userDir: '/nonexistent',
        projectDir: '/nonexistent',
      }),
      germinatedSection: '',
    };
  }
  const registry = await SporeRegistry.discover({
    bundledDir: BUNDLED_SPORES_DIR,
    userDir: USER_SPORES_DIR,
    projectDir: projectSporesDir,
  });
  const pinned = await readPin(cwd);
  let activeSpore: string | null = null;
  let germinatedSection = '';
  if (pinned) {
    const spore = registry.get(pinned);
    if (spore) {
      const sectorRaw = await readFile(spore.sectorSkillPath, 'utf8');
      const { body } = parseSkillFrontmatter(sectorRaw);
      germinatedSection = `\n\n<!-- BEGIN GERMINATED SPORE: ${spore.name} -->\n${body.trim()}\n<!-- END GERMINATED SPORE: ${spore.name} -->\n`;
      activeSpore = spore.name;
    }
  }
  return { activeSpore, registry, germinatedSection };
}
