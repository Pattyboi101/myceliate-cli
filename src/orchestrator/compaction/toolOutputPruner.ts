// src/orchestrator/compaction/toolOutputPruner.ts
import type { Message, ToolResultMessage } from '../../adapters/messages.js';

export type PruneOptions = {
  maxToolOutputChars: number;
  /** Most recent N messages are immune to pruning. */
  protectedTailMessages: number;
};

export function pruneToolOutputs(history: readonly Message[], opts: PruneOptions): Message[] {
  const protectedFrom = Math.max(0, history.length - opts.protectedTailMessages);
  const seenReads = new Map<string, number>();

  // First pass: index latest read_file results so we can drop earlier ones.
  history.forEach((m, i) => {
    if (m.role === 'tool' && m.result.command.startsWith('read_file')) {
      seenReads.set(m.result.command, i);
    }
  });

  const out: Message[] = [];
  history.forEach((m, i) => {
    if (m.role === 'tool') {
      // Dedup: drop earlier read_file results.
      if (m.result.command.startsWith('read_file') && seenReads.get(m.result.command) !== i) {
        return;
      }
      // Truncate oversized content in the unprotected zone only.
      if (i < protectedFrom && m.result.content.length > opts.maxToolOutputChars) {
        const truncated: ToolResultMessage = {
          role: 'tool',
          result: {
            ...m.result,
            content: `${m.result.content.slice(0, opts.maxToolOutputChars)}\n\n[truncated: original ${m.result.content.length} chars]`,
          },
        };
        out.push(truncated);
        return;
      }
    }
    out.push(m);
  });
  return out;
}
