import type { CommandRecord } from './CommandRecord.js';
import type { SporeManifest } from './SporeManifest.js';
import type { SkillFrontmatter } from './skillFrontmatter.js';

export type SporeTier = 'bundled' | 'user' | 'project';

export interface PersonaRef {
  name: string;
  /** Absolute path to the persona's SKILL.md file. Loaded only on spawn_subagent. */
  skillPath: string;
  /** Description from the persona's frontmatter — exposed for the orchestrator's roster context. */
  description: string;
}

export interface Spore {
  /** Spore name (matches manifest.name + directory name). */
  name: string;
  /** Tier this spore was loaded from. Higher tiers override lower with the same name. */
  tier: SporeTier;
  /** Absolute path to the spore directory. */
  dir: string;
  /** Parsed myceliate.yaml. */
  manifest: SporeManifest;
  /** Sector-level SKILL.md frontmatter. */
  sectorFrontmatter: SkillFrontmatter;
  /** Path to the sector-level SKILL.md (body loaded on germination). */
  sectorSkillPath: string;
  /** Persona refs (lazy — bodies loaded only when spawned). */
  personas: PersonaRef[];
  /** Per-pack slash command refs (lazy — bodies loaded on dispatch). */
  commands: CommandRecord[];
}
