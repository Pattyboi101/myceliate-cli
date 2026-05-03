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
  | { type: 'turn_complete' }
  /**
   * Synthetic lifecycle event yielded by `runReactLoop` when a tool call
   * resolves, rejects, or is vetoed by the HITL gate. Adapters never emit it
   * (case is added to their switches for exhaustiveness only). The `id`
   * matches the originating `tool_call.id` so the UI can map status updates
   * onto rendered cards. `durationMs` measures `tools.invoke` wall time on the
   * success path; on the failure path it includes any artifact-offload time
   * before the throw. `preview` is the redacted, truncated head of the result
   * content (≤200 chars). `cause` is set on failures for structured surfacing.
   *
   * `status: 'rejected'` is type-allowed for the HITL veto path but is not
   * yielded by `runReactLoop` in v1.1 — Phase 14 Task 92 wires the bash tool's
   * dangerous-command rejection into this status. `<ToolCallCard>` already
   * renders the rejected state (test coverage exists) so Phase 14 needs only
   * the orchestrator-side emission.
   */
  | {
      type: 'tool_result';
      id: string;
      status: 'completed' | 'failed' | 'rejected';
      durationMs: number;
      preview?: string;
      cause?: unknown;
    };

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
export const isToolResult = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_result' }> =>
  e.type === 'tool_result';
