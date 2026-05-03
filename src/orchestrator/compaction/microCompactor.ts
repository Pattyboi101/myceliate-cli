// src/orchestrator/compaction/microCompactor.ts
import type { Message } from '../../adapters/messages.js';

export type MicroOptions = { protectedTailMessages: number };

/**
 * The placeholder string written into a tool result's `content` after
 * micro-compaction. Exported so callers and tests can identify a compacted
 * tool result without duplicating the literal.
 */
export const MICRO_COMPACTED_PLACEHOLDER = '[micro-compacted]';

export function microCompact(history: readonly Message[], opts: MicroOptions): Message[] {
  const protectedFrom = Math.max(0, history.length - opts.protectedTailMessages);
  return history.map((m, i) => {
    if (m.role === 'tool' && i < protectedFrom) {
      return {
        role: 'tool',
        result: {
          tool_use_id: m.result.tool_use_id,
          command: m.result.command,
          is_error: m.result.is_error,
          content: MICRO_COMPACTED_PLACEHOLDER,
        },
      } as const;
    }
    return m;
  });
}
