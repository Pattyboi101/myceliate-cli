import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonaRef, Spore, SporeTier } from './Spore.js';
import { parseSporeManifest } from './SporeManifest.js';
import { parseSkillFrontmatter } from './skillFrontmatter.js';

export interface RegistryDirs {
  bundledDir: string;
  userDir: string;
  projectDir: string;
}

export interface SporeDescription {
  name: string;
  description: string;
  accent_color: string;
}

export class SporeRegistry {
  private constructor(private readonly spores: Map<string, Spore>) {}

  static async discover(dirs: RegistryDirs): Promise<SporeRegistry> {
    const accumulated = new Map<string, Spore>();
    const tierDirs: Array<[SporeTier, string]> = [
      ['bundled', dirs.bundledDir],
      ['user', dirs.userDir],
      ['project', dirs.projectDir],
    ];
    for (const [tier, root] of tierDirs) {
      const found = await SporeRegistry.scanTier(tier, root);
      for (const spore of found) {
        const existing = accumulated.get(spore.name);
        if (existing) {
          // TODO(v1.4): thread Logger via DI per CLAUDE.md U4
          console.warn(
            `[spores] override: ${spore.name} from ${existing.tier} (${existing.dir}) replaced by ${spore.tier} (${spore.dir})`,
          );
        }
        accumulated.set(spore.name, spore);
      }
    }
    return new SporeRegistry(accumulated);
  }

  private static async scanTier(tier: SporeTier, root: string): Promise<Spore[]> {
    let entries: string[];
    try {
      const dirEntries = await readdir(root, { withFileTypes: true });
      entries = dirEntries
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      // Missing tier dir — silent, that's expected for fresh installs / projects without project-tier spores
      return [];
    }
    const out: Spore[] = [];
    for (const name of entries) {
      const dir = join(root, name);
      try {
        const spore = await SporeRegistry.loadSpore(tier, dir, name);
        out.push(spore);
      } catch (err) {
        // TODO(v1.4): thread Logger via DI per CLAUDE.md U4
        console.warn(`[spores] skipped ${tier}/${name}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private static async loadSpore(tier: SporeTier, dir: string, name: string): Promise<Spore> {
    const manifestPath = join(dir, 'myceliate.yaml');
    const sectorSkillPath = join(dir, 'SKILL.md');
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const manifest = parseSporeManifest(manifestRaw);
    if (manifest.name !== name) {
      throw new Error(`manifest name "${manifest.name}" does not match directory name "${name}"`);
    }
    const sectorRaw = await readFile(sectorSkillPath, 'utf8');
    const { frontmatter: sectorFrontmatter } = parseSkillFrontmatter(sectorRaw);
    const personas: PersonaRef[] = [];
    for (const agentName of manifest.agents) {
      const personaPath = join(dir, 'agents', agentName, 'SKILL.md');
      try {
        const raw = await readFile(personaPath, 'utf8');
        const { frontmatter } = parseSkillFrontmatter(raw);
        personas.push({
          name: frontmatter.name,
          skillPath: personaPath,
          description: frontmatter.description,
        });
      } catch (err) {
        console.warn(`[spores] persona ${name}/${agentName} skipped: ${(err as Error).message}`);
      }
    }
    return { name, tier, dir, manifest, sectorFrontmatter, sectorSkillPath, personas };
  }

  list(): Spore[] {
    return [...this.spores.values()];
  }

  get(name: string): Spore | undefined {
    return this.spores.get(name);
  }

  getDescriptions(): SporeDescription[] {
    return this.list().map((s) => ({
      name: s.name,
      description: s.sectorFrontmatter.description,
      accent_color: s.manifest.accent_color,
    }));
  }
}
