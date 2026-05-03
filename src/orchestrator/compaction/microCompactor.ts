// src/orchestrator/compaction/microCompactor.ts
import type { Message } from '../../adapters/messages.js';

export type MicroOptions = { protectedTailMessages: number };

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
          content: '[micro-compacted]',
        },
      } as const;
    }
    return m;
  });
}
