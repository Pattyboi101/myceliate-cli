import type { SporeRegistry } from '../spores/SporeRegistry.js';

export interface ComposeOpts {
  registry: SporeRegistry;
  activeSpore: string | null;
}

export function composeSystemSections(opts: ComposeOpts): string {
  const descs = opts.registry.getDescriptions();
  if (descs.length === 0) return '';

  const sectorList = descs
    .map((d) => `- \`${d.name}\` (${d.accent_color}): ${d.description}`)
    .join('\n');

  const sectorBlock = `\n\n## Available sector spores\n\nIf the user's intent aligns with one of these sectors, you MUST call the \`germinate_spore({ name })\` tool immediately — before answering — to load that sector's persona roster into context. Skip germination only when the request is genuinely off-sector or trivially conversational ("what's 2+2", "hi"). Don't try to answer in-sector questions from base weights when the right spore is right there.\n\n${sectorList}\n`;

  if (!opts.activeSpore) return sectorBlock;
  const active = opts.registry.get(opts.activeSpore);
  if (!active || active.commands.length === 0) return sectorBlock;

  const commandList = active.commands
    .map((c) => {
      const hint = c.argumentHint ? ` ${c.argumentHint}` : '';
      return `- \`/${active.name}:${c.name}${hint}\` — ${c.description}`;
    })
    .join('\n');

  const commandBlock = `\n## Available commands for \`${active.name}\`\n\nThe user can dispatch these slash commands. When their intent matches one, suggest it explicitly (e.g. "Try \`/${active.name}:${active.commands[0]?.name}\` for that").\n\n${commandList}\n`;

  return `${sectorBlock}${commandBlock}`;
}
