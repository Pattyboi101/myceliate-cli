import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { GerminationEvent, StreamEvent } from '../adapters/streamEvent.js';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { writePin } from '../spores/pinFile.js';
import { parseSkillFrontmatter } from '../spores/skillFrontmatter.js';
import type { Logger } from '../util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

export const GerminateSporeInputSchema = z.object({ name: z.string().min(1) }).strict();
export type GerminateSporeInput = z.infer<typeof GerminateSporeInputSchema>;

export type GerminateSporeResult = { ok: true; spore: string } | { ok: false; error: string };

export interface GerminateSporeDeps {
  registry: SporeRegistry;
  cwd: string;
  emit: (e: StreamEvent) => void;
  /**
   * Replaces any prior germinated-context section (or appends if none exists).
   * Phase 21 stretch: uses QueryEngine.replaceGerminatedSection to avoid stacking
   * two sector bodies when the model calls germinate_spore twice in one session.
   */
  appendSystemPrompt: (body: string) => void;
  /** Optional logger — when absent, a silent no-op is used. */
  logger?: Logger;
}

export interface GerminateSporeTool {
  name: 'germinate_spore';
  description: string;
  inputSchema: typeof GerminateSporeInputSchema;
  handler: (input: GerminateSporeInput) => Promise<GerminateSporeResult>;
}

export function createGerminateSporeTool(deps: GerminateSporeDeps): GerminateSporeTool {
  return {
    name: 'germinate_spore',
    description:
      'Germinate a sector spore — load its SKILL.md body into the orchestrator system prompt, pin it for the project, and unlock its persona roster for spawn_subagent.',
    inputSchema: GerminateSporeInputSchema,
    async handler({ name }) {
      const spore = deps.registry.get(name);
      if (!spore) return { ok: false, error: `unknown spore "${name}"` };
      const sectorRaw = await readFile(spore.sectorSkillPath, 'utf8');
      const { body } = parseSkillFrontmatter(sectorRaw);
      const delimited = `\n\n<!-- BEGIN GERMINATED SPORE: ${spore.name} -->\n${body.trim()}\n<!-- END GERMINATED SPORE: ${spore.name} -->\n`;
      deps.appendSystemPrompt(delimited);
      await writePin(deps.cwd, spore.name, deps.logger ?? noopLogger);
      const event: GerminationEvent = {
        type: 'germination',
        spore: spore.name,
        accent_color: spore.manifest.accent_color,
        message: `Germinating ${spore.name} spore`,
      };
      deps.emit(event);
      return { ok: true, spore: spore.name };
    },
  };
}
