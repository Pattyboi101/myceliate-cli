// src/runtime/resume.ts
import type { Message } from '../adapters/messages.js';
import type { CompletedTurn } from '../ui/App.js';

// parseResumeFlag removed in Phase 3 (Exoenzyme) — logic moved to
// src/cli/parseSubcommand.ts (interactive branch).  Import parseSubcommand
// from there instead.

/**
 * Refuse to resume a session whose final assistant turn has tool_calls
 * without matching tool results. Such a session was interrupted mid-flow
 * (e.g., crashed after the LLM emitted tool_calls but before the worker
 * returned). Resuming would produce a malformed next request — the LLM
 * receives `tool_calls` without their `tool_use_id` results.
 *
 * v1.2 v1: refuse outright. v1.3 may grow a "discard mid-flight tool_calls"
 * recovery path that strips the unanswered assistant turn and resumes from
 * the preceding state.
 *
 * noUncheckedIndexedAccess: history[i] returns Message | undefined — all
 * accesses are guarded by truthiness checks before use.
 */
export function isSafeToResume(history: readonly Message[]): boolean {
  if (history.length === 0) return true;

  // Find the last assistant message that has tool_calls (backward scan).
  let lastAssistantWithCallsIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      lastAssistantWithCallsIdx = i;
      break;
    }
  }
  if (lastAssistantWithCallsIdx === -1) return true;

  // The loop above guarantees this access is safe and the role/tool_calls
  // shape matches; the explicit guard below is dead code defensively kept
  // for noUncheckedIndexedAccess narrowing.
  const assistantMsg = history[lastAssistantWithCallsIdx];
  if (!assistantMsg || assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) {
    return true; // unreachable: loop invariant guarantees role === 'assistant' && tool_calls
  }

  // Forward scan: collect every tool_use_id that has a matching subsequent
  // tool message; safe to resume iff every expected id was answered.
  const expectedIds = new Set(assistantMsg.tool_calls.map((tc) => tc.id));
  for (let i = lastAssistantWithCallsIdx + 1; i < history.length; i++) {
    const m = history[i];
    if (m && m.role === 'tool') expectedIds.delete(m.result.tool_use_id);
  }
  return expectedIds.size === 0;
}

/**
 * Pair user messages with the next terminal assistant message (one without
 * tool_calls) to reconstruct CompletedTurn[] for the UI's turn history.
 * Skips tool messages and assistant tool-call messages (those are internal
 * to the ReAct loop and don't have a direct UI representation). Also skips
 * orphaned user messages (a final user with no following terminal assistant
 * — that input is in-flight, not yet a completed turn).
 *
 * Phase 18 review n1: returns the same `CompletedTurn` type the UI consumes
 * (imported from `src/ui/App.js`) — previously a duplicate `CompletedTurnLike`
 * type lived here.
 */
export function buildTurnsFromHistory(history: readonly Message[]): CompletedTurn[] {
  const turns: CompletedTurn[] = [];
  let pendingUser: string | null = null;
  for (const m of history) {
    if (m.role === 'user') {
      pendingUser = m.content;
    } else if (
      m.role === 'assistant' &&
      pendingUser !== null &&
      (!m.tool_calls || m.tool_calls.length === 0)
    ) {
      turns.push({ userInput: pendingUser, content: m.content ?? '' });
      pendingUser = null;
    }
  }
  return turns;
}

// parseNoSporeFlag removed in Phase 3 (Exoenzyme) — logic moved to
// src/cli/parseSubcommand.ts (interactive branch).  Import parseSubcommand
// from there instead.
