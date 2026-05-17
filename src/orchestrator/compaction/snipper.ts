// src/orchestrator/compaction/snipper.ts
import type { Message } from '../../adapters/messages.js';
import { estimateMessageTokens } from '../../util/tokens.js';

export type SnipOptions = { protectedTailTokens: number };

export function snipDeadEnds(history: readonly Message[], opts: SnipOptions): Message[] {
  const protectedFrom = computeProtectedStart(history, opts.protectedTailTokens);
  const result: Message[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (!m) break;
    // Always preserve system messages and the protected tail.
    if (m.role === 'system' || i >= protectedFrom) {
      result.push(m);
      i++;
      continue;
    }
    // Detect error runs of 3+ consecutive failing tool results in the unprotected zone.
    if (m.role === 'tool' && m.result.is_error) {
      let runEnd = i;
      while (runEnd < history.length) {
        const n = history[runEnd];
        if (!n) break;
        if (n.role === 'tool' && n.result.is_error && runEnd < protectedFrom) runEnd++;
        else break;
      }
      const runLen = runEnd - i;
      if (runLen >= 3) {
        // Replace the dead-end run with a single marker note.
        result.push({
          role: 'system',
          content: `[snipped ${runLen} consecutive failed tool calls — abandoned trajectory]`,
        });
        i = runEnd;
        continue;
      }
    }
    result.push(m);
    i++;
  }
  return result;
}

/**
 * Computes the starting index of the protected tail by walking backward from the
 * end of history and accumulating token estimates until the budget is reached.
 */
export function computeProtectedStart(
  history: readonly Message[],
  protectedTailTokens: number,
): number {
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    acc += estimateMessageTokens(m);
    if (acc >= protectedTailTokens) return i;
  }
  return 0;
}
