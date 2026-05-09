import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../util/logger.js';
import type { CommandRecord } from './CommandRecord.js';
import type { PersonaRef, Spore, SporeTier } from './Spore.js';
import { parseSporeManifest } from './SporeManifest.js';
import { parseSkillFrontmatter } from './skillFrontmatter.js';

export interface RegistryDirs {
  bundledDir: string;
  userDir: string;
  projectDir: string;
}

export interface RegistryDiscoverOpts {
  logger: Logger;
}

export interface SporeDescription {
  name: string;
  description: string;
  accent_color: string;
}

export class SporeRegistry {
  private constructor(private readonly spores: Map<string, Spore>) {}

  static async discover(dirs: RegistryDirs, opts: RegistryDiscoverOpts): Promise<SporeRegistry> {
    const accumulated = new Map<string, Spore>();
    const tierDirs: Array<[SporeTier, string]> = [
      ['bundled', dirs.bundledDir],
      ['user', dirs.userDir],
      ['project', dirs.projectDir],
    ];
    for (const [tier, root] of tierDirs) {
      const found = await SporeRegistry.scanTier(tier, root, opts.logger);
      for (const spore of found) {
        const existing = accumulated.get(spore.name);
        if (existing) {
          opts.logger.warn({
            event: 'spore_override',
            name: spore.name,
            from_tier: existing.tier,
            from_dir: existing.dir,
            to_tier: spore.tier,
            to_dir: spore.dir,
          });
        }
        accumulated.set(spore.name, spore);
      }
    }
    return new SporeRegistry(accumulated);
  }

  static empty(): SporeRegistry {
    return new SporeRegistry(new Map());
  }

  /**
   * Test-only factory: build a registry from a flat Spore[] without disk I/O.
   * Production code uses discover(); tests use fromList() to avoid fixture sprawl.
   */
  static fromList(spores: Spore[]): SporeRegistry {
    const map = new Map<string, Spore>();
    for (const s of spores) map.set(s.name, s);
    return new SporeRegistry(map);
  }

  private static async scanTier(tier: SporeTier, root: string, logger: Logger): Promise<Spore[]> {
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
        const spore = await SporeRegistry.loadSpore(tier, dir, name, logger);
        out.push(spore);
      } catch (err) {
        logger.warn({
          event: 'spore_load_skipped',
          tier,
          name,
          message: (err as Error).message,
        });
      }
    }
    return out;
  }

  private static async loadSpore(
    tier: SporeTier,
    dir: string,
    name: string,
    logger: Logger,
  ): Promise<Spore> {
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
        logger.warn({
          event: 'persona_load_skipped',
          spore: name,
          agent: agentName,
          message: (err as Error).message,
        });
      }
    }

    // Per-pack commands discovery — walks commands/*.md
    const commands = await SporeRegistry.loadCommands(dir, name, logger);

    return { name, tier, dir, manifest, sectorFrontmatter, sectorSkillPath, personas, commands };
  }

  private static async loadCommands(
    dir: string,
    sporeName: string,
    logger: Logger,
  ): Promise<CommandRecord[]> {
    const commandsDir = join(dir, 'commands');
    let commandEntries: import('node:fs').Dirent[];
    try {
      commandEntries = await readdir(commandsDir, { withFileTypes: true });
    } catch {
      // commands/ absent — that's fine, leave commands empty.
      return [];
    }

    const out: CommandRecord[] = [];

    for (const entry of commandEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const cmdPath = join(commandsDir, entry.name);
      const basename = entry.name.slice(0, -3); // strip .md
      try {
        const raw = await readFile(cmdPath, 'utf8');
        const { frontmatter } = parseSkillFrontmatter(raw);
        if (frontmatter.name !== basename) {
          logger.warn({
            event: 'command_filename_mismatch',
            spore: sporeName,
            file: entry.name,
            frontmatter_name: frontmatter.name,
          });
          continue;
        }
        const argumentHint = (frontmatter as Record<string, unknown>)['argument-hint'] as
          | string
          | undefined;
        out.push({
          name: frontmatter.name,
          description: frontmatter.description,
          ...(argumentHint ? { argumentHint } : {}),
          bodyPath: cmdPath,
        });
      } catch (err) {
        logger.warn({
          event: 'command_load_skipped',
          spore: sporeName,
          file: entry.name,
          message: (err as Error).message,
        });
      }
    }

    return out;
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
