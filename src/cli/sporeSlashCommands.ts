// src/cli/sporeSlashCommands.ts
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { clearPin, writePin } from '../spores/pinFile.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/noopLogger.js';

export interface SporeListArgs {
  registry: SporeRegistry;
}

export async function handleSporeList(args: SporeListArgs): Promise<string> {
  const spores = args.registry.list();
  if (spores.length === 0) return 'No spores discovered.';
  const lines: string[] = ['CATALOG'];
  for (const s of spores) {
    const padded = s.name.padEnd(16);
    const tier = `[${s.tier}]`.padEnd(12);
    const color = s.manifest.accent_color.padEnd(10);
    const count = `${s.personas.length} persona${s.personas.length === 1 ? '' : 's'}`;
    lines.push(`  ${padded}${tier}${color}${count}`);
  }
  return lines.join('\n');
}

export interface SporePinArgs {
  registry: SporeRegistry;
  cwd: string;
  name: string;
  logger?: Logger;
}

export type SporeCommandResult = { ok: true; message: string } | { ok: false; message: string };

export async function handleSporePin(args: SporePinArgs): Promise<SporeCommandResult> {
  if (!args.registry.get(args.name)) return { ok: false, message: `unknown spore "${args.name}"` };
  await writePin(args.cwd, args.name, args.logger ?? noopLogger);
  return { ok: true, message: `Pinned ${args.name}` };
}

export interface SporeUnpinArgs {
  cwd: string;
  logger?: Logger;
}

export async function handleSporeUnpin(args: SporeUnpinArgs): Promise<SporeCommandResult> {
  await clearPin(args.cwd, args.logger ?? noopLogger);
  return { ok: true, message: 'Unpinned' };
}
