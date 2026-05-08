import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { parseSkillFrontmatter } from '../spores/skillFrontmatter.js';

export const SpawnSubagentInputSchema = z
  .object({
    persona: z.string().min(1),
    task: z.string().min(1),
  })
  .strict();
export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInputSchema>;

export type SpawnSubagentResult =
  | { ok: true; persona: string; summary: string }
  | { ok: false; error: string; stderr_tail?: string };

export interface SpawnRequest {
  persona_name: string;
  persona_skill: string;
  task: string;
}

export interface SpawnResponse {
  ok: boolean;
  summary?: string;
  error?: string;
  stderr_tail?: string;
}

export interface SpawnSubagentDeps {
  registry: SporeRegistry;
  /** Returns the currently-active spore name, or null. Used to scope persona lookup. */
  activeSpore: () => string | null;
  /** Process-spawn function (DI seam — production uses childProcessSpawn, tests stub). */
  spawn: (req: SpawnRequest) => Promise<SpawnResponse>;
}

export interface SpawnSubagentTool {
  name: 'spawn_subagent';
  description: string;
  inputSchema: typeof SpawnSubagentInputSchema;
  handler: (input: SpawnSubagentInput) => Promise<SpawnSubagentResult>;
}

export function createSpawnSubagentTool(deps: SpawnSubagentDeps): SpawnSubagentTool {
  return {
    name: 'spawn_subagent',
    description:
      "Spawn a persona sub-agent for a focused task. The sub-agent runs with its own fresh context window and the persona's SKILL.md as its system prompt.",
    inputSchema: SpawnSubagentInputSchema,
    async handler({ persona, task }) {
      const activeName = deps.activeSpore();
      const sporesToSearch = activeName ? [activeName] : deps.registry.list().map((s) => s.name);
      let personaRef: { name: string; skillPath: string } | null = null;
      for (const sporeName of sporesToSearch) {
        const spore = deps.registry.get(sporeName);
        if (!spore) continue;
        const found = spore.personas.find((p) => p.name === persona);
        if (found) {
          personaRef = found;
          break;
        }
      }
      if (!personaRef) return { ok: false, error: `unknown persona "${persona}"` };
      const raw = await readFile(personaRef.skillPath, 'utf8');
      const { body: personaBody } = parseSkillFrontmatter(raw);
      const response = await deps.spawn({
        persona_name: personaRef.name,
        persona_skill: personaBody,
        task,
      });
      if (!response.ok) {
        return {
          ok: false,
          error: response.error ?? 'unknown spawn error',
          ...(response.stderr_tail ? { stderr_tail: response.stderr_tail } : {}),
        };
      }
      return { ok: true, persona: personaRef.name, summary: response.summary ?? '' };
    },
  };
}
