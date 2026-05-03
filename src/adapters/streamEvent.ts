export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens?: number;
};

export type StreamEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; cause: unknown }
  /**
   * Synthetic boundary marker yielded by `runReactLoop` between iterations of a
   * multi-turn ReAct loop (the previous turn ended with tool_calls; the next
   * is about to begin). Adapters never emit this — it's a consumer-side signal
   * to reset per-turn UI state (reasoning text, started-at timestamp, etc.)
   * so turn 2's reasoning panel does not concatenate onto turn 1's. See F4.
   */
  | { type: 'turn_complete' };

export const isReasoningDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'reasoning_delta' }> => e.type === 'reasoning_delta';
export const isContentDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta';
export const isToolCall = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_call' }> =>
  e.type === 'tool_call';
export const isDone = (e: StreamEvent): e is Extract<StreamEvent, { type: 'done' }> =>
  e.type === 'done';
export const isError = (e: StreamEvent): e is Extract<StreamEvent, { type: 'error' }> =>
  e.type === 'error';
