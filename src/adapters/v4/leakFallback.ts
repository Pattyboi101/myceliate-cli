import type { ToolCall } from '../messages.js';
import { DsmlParser } from './dsmlParser.js';
import { isToolCall, isContentDelta } from '../streamEvent.js';

export type LeakResult = { cleanedText: string; toolCalls: ToolCall[] };

/**
 * Detects and extracts DSML tool_call markup that was leaked into a raw text
 * payload by middleware (vLLM, NVIDIA NIM) that failed to intercept the markers.
 *
 * Returns the cleaned text (DSML stripped) and any extracted tool calls.
 * When no DSML leak is present, returns the original text with an empty toolCalls array.
 */
export function detectLeakedDsml(text: string): LeakResult {
  if (!text.includes('<|DSML|tool_calls>')) return { cleanedText: text, toolCalls: [] };
  const parser = new DsmlParser();
  const events = parser.feed(text);
  const toolCalls: ToolCall[] = [];
  let cleanedText = '';
  for (const ev of events) {
    if (isToolCall(ev)) toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
    else if (isContentDelta(ev)) cleanedText += ev.text;
  }
  return { cleanedText, toolCalls };
}
