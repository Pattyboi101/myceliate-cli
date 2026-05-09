import { readFile } from 'node:fs/promises';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { parseSkillFrontmatter } from '../spores/skillFrontmatter.js';
import type { Logger } from '../util/logger.js';

const NAMESPACED_RE = /^\/([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)(?:\s+(.*))?$/;

export type DispatchResult =
  | { kind: 'expanded-prompt'; body: string }
  | { kind: 'orchestrator-output'; text: string }
  | { kind: 'no-match' };

export interface DispatchContext {
  registry: SporeRegistry;
  activeSpore: string | null;
  cwd: string;
  logger: Logger;
}

export async function dispatch(input: string, ctx: DispatchContext): Promise<DispatchResult> {
  const match = NAMESPACED_RE.exec(input);
  if (!match) return { kind: 'no-match' };

  const [, packName, commandName, rawArgs] = match;
  if (!packName || !commandName) return { kind: 'no-match' };
  const args = rawArgs ?? '';

  ctx.logger.info({
    event: 'slash_dispatched',
    pack: packName,
    command: commandName,
    args_length: args.length,
  });

  const pack = ctx.registry.get(packName);
  if (!pack) {
    return { kind: 'orchestrator-output', text: `no spore named "${packName}"` };
  }

  const command = pack.commands.find((c) => c.name === commandName);
  if (!command) {
    return {
      kind: 'orchestrator-output',
      text: `spore "${packName}" has no command "${commandName}"`,
    };
  }

  if (ctx.activeSpore !== packName) {
    return {
      kind: 'orchestrator-output',
      text: `/${packName}:${commandName} requires the "${packName}" spore to be active. Pin it first via \`/spore pin ${packName}\`.`,
    };
  }

  const raw = await readFile(command.bodyPath, 'utf8');
  const { body } = parseSkillFrontmatter(raw);
  const expanded = expandBody(body.trim(), args);
  return { kind: 'expanded-prompt', body: expanded };
}

function expandBody(body: string, args: string): string {
  if (body.includes('$ARGUMENTS')) {
    return body.split('$ARGUMENTS').join(args);
  }
  return `${body}\n\n${args}`;
}
