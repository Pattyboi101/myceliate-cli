// src/runtime/resume.ts
import type { Message } from '../adapters/messages.js';

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

  // Find the last assistant message that has tool_calls.
  let lastAssistantWithCallsIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      lastAssistantWithCallsIdx = i;
      break;
    }
  }
  if (lastAssistantWithCallsIdx === -1) return true;

  const assistantMsg = history[lastAssistantWithCallsIdx];
  if (!assistantMsg || assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) {
    return true; // Defensive — should be unreachable given the loop guard.
  }

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
 * to the ReAct loop and don't have a direct UI representation).
 */
export type CompletedTurnLike = { userInput: string; content: string };

export function buildTurnsFromHistory(history: readonly Message[]): CompletedTurnLike[] {
  const turns: CompletedTurnLike[] = [];
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
