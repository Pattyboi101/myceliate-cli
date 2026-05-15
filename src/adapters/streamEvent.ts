export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens?: number;
};

/**
 * Emitted by `germinate_spore` when a sector spore is activated.
 * Flows through the orchestrator's event stream so the UI can
 * render a "Germinating <spore>" notification and update the accent colour.
 *
 * Uses `type: 'germination'` like every other variant — unified discriminant
 * keeps `switch (event.type)` exhaustiveness working and avoids the per-call
 * `'kind' in e` guards that mixed-discriminant unions force.
 */
export interface GerminationEvent {
  type: 'germination';
  spore: string;
  accent_color: string;
  message: string;
}

export type StreamEvent =
  | { type: 'content_delta'; text: string }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; cause: unknown }
  | GerminationEvent
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
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
    }
  /**
   * Phase 3 (Exoenzyme): synthetic lifecycle notification emitted by
   * `teardownMcpSpore` when an MCP server is torn down (either unexpectedly or
   * by explicit /spore unpin). Distinct from `error` (which implies failure)
   * and `germination` (which implies start). Rendered by the UI as a banner or
   * status line. `text` is a human-readable summary including removed wrapper
   * count.
   */
  | { type: 'system_message'; text: string }
  /**
   * Phase 2.5 (T37): synthetic telemetry event emitted by the orchestrator's
   * spawn_subagent tool wrapper after the subagent subprocess completes.
   * One event per subagent step, carrying wall-clock duration and the model
   * used. Consumed by the live telemetry footer (T39/T40).
   * `step` is 0-indexed; `durationMs` is wall-clock time for that step;
   * `model` is the subagent model string (e.g. `deepseek-v4-flash`).
   */
  | {
      type: 'subagent_step';
      step: number;
      durationMs: number;
      model: string;
    }
  /**
   * Phase 2.5 (T38): synthetic lifecycle event yielded by `runReactLoop`
   * immediately before each iteration's API request. Carries the resolved
   * model string so the UI can update the routing indicator in ReasoningBlock
   * without polling the logger.
   *
   * Subagent-side: `runSubagentLoop` is not a generator function and cannot
   * yield; the subagent's model is always deterministic Flash so the orchestrator
   * routing indicator does not need per-step subagent updates. The log event
   * (`logger?.info({ event: 'request_started', ... })`) still fires in
   * subagentLoop.ts — only the stream-event yield is omitted there.
   *
   * `iter` is the 0-based iteration index within the current ReAct loop.
   * `step` is reserved for future subagent-side emission (Option a path).
   */
  | {
      type: 'request_started';
      role: string;
      model: string;
      iter?: number;
      step?: number;
    };

export const isGermination = (e: StreamEvent): e is GerminationEvent =>
  'type' in e && e.type === 'germination';
export const isReasoningDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'reasoning_delta' }> =>
  'type' in e && e.type === 'reasoning_delta';
export const isContentDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'content_delta' }> =>
  'type' in e && e.type === 'content_delta';
export const isToolCall = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_call' }> =>
  'type' in e && e.type === 'tool_call';
export const isDone = (e: StreamEvent): e is Extract<StreamEvent, { type: 'done' }> =>
  'type' in e && e.type === 'done';
export const isError = (e: StreamEvent): e is Extract<StreamEvent, { type: 'error' }> =>
  'type' in e && e.type === 'error';
export const isToolResult = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_result' }> =>
  'type' in e && e.type === 'tool_result';
export const isTurnComplete = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'turn_complete' }> =>
  'type' in e && e.type === 'turn_complete';
export const isSystemMessage = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'system_message' }> =>
  'type' in e && e.type === 'system_message';
export function isSubagentStep(
  ev: unknown,
): ev is { type: 'subagent_step'; step: number; durationMs: number; model: string } {
  return (
    typeof ev === 'object' && ev !== null && (ev as { type?: string }).type === 'subagent_step'
  );
}
export function isRequestStarted(
  ev: unknown,
): ev is { type: 'request_started'; role: string; model: string; iter?: number; step?: number } {
  return (
    typeof ev === 'object' && ev !== null && (ev as { type?: string }).type === 'request_started'
  );
}
