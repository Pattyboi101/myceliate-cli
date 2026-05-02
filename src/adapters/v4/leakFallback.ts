import type { ToolCall } from '../messages.js';
import { isContentDelta, isToolCall } from '../streamEvent.js';
import { CLOSE_BLOCK, DsmlParser, OPEN_BLOCK } from './dsmlParser.js';

export type LeakResult = { cleanedText: string; toolCalls: ToolCall[] };

/**
 * Detects and extracts DSML tool_call markup that was leaked into a raw text
 * payload by middleware (vLLM, NVIDIA NIM) that failed to intercept the markers.
 *
 * Returns the cleaned text (DSML stripped) and any extracted tool calls.
 * When no DSML leak is present, returns the original text with an empty toolCalls array.
 *
 * Lossless rescue: when the upstream emits an OPEN_BLOCK without a matching
 * CLOSE_BLOCK (truly malformed leak — not a real tool call), the original text
 * is preserved verbatim. The parser's `flush()` also drains any tail content
 * the safe-prefix logic withheld.
 */
export function detectLeakedDsml(text: string): LeakResult {
  if (!text.includes(OPEN_BLOCK)) return { cleanedText: text, toolCalls: [] };
  // Malformed leak (open without close): refuse to interpret it as a tool call.
  // Returning the raw text means the user-visible reasoning is preserved.
  if (!text.includes(CLOSE_BLOCK)) return { cleanedText: text, toolCalls: [] };

  const parser = new DsmlParser();
  const events = [...parser.feed(text), ...parser.flush()];
  const toolCalls: ToolCall[] = [];
  let cleanedText = '';
  for (const ev of events) {
    if (isToolCall(ev)) toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
    else if (isContentDelta(ev)) cleanedText += ev.text;
  }
  return { cleanedText, toolCalls };
}
