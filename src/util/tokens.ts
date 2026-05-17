// src/util/tokens.ts
import type { Message } from '../adapters/messages.js';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(m: Message): number {
  switch (m.role) {
    case 'system':
    case 'user':
      return estimateTokens(m.content) + 4;
    case 'assistant': {
      // content can be null (tool-call-only turns per AssistantMessage type)
      let n = (m.content !== null ? estimateTokens(m.content) : 0) + 4;
      if (m.reasoning_content) n += estimateTokens(m.reasoning_content);
      if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
      return n;
    }
    case 'tool':
      return estimateTokens(m.result.content) + estimateTokens(m.result.command) + 8;
  }
}

export function estimateHistoryTokens(msgs: readonly Message[]): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
