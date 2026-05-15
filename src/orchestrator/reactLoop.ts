// src/orchestrator/reactLoop.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { ToolCall } from '../adapters/messages.js';
import { type StreamEvent, isGermination } from '../adapters/streamEvent.js';
import type { MarkdownStore } from '../memory/markdownStore.js';
import type { CavemanState } from '../runtime/cavemanMode.js';
import { type CostBreakdown, calculateCost } from '../runtime/costCalculator.js';
import { type SporeRole, roleToModel } from '../runtime/roleToModel.js';
import { redactSecrets } from '../security/redactor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger } from '../util/logger.js';
import type { QueryEngine } from './QueryEngine.js';

export type ReactLoopOptions = {
  client: DeepSeekClient;
  engine: QueryEngine;
  tools: ToolRegistry;
  /** Optional explicit override; when unset, role-based dispatch fires per iter. */
  model?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  /** Working directory threaded to every tool invocation. */
  cwd?: string;
  /**
   * If provided, oversized tool results are offloaded to this store.
   * The conversation log gets a compact pointer instead of raw content.
   */
  artifactStore?: MarkdownStore;
  /**
   * Byte threshold for artifact offloading. Tool results larger than this
   * are stored as artifacts. Default: 4096 (~1k tokens).
   */
  artifactThresholdBytes?: number;
  /**
   * Phase 2 closure: per-iteration `request_started` log line for the
   * routing-pattern smoke (walk-point 9). Optional so the loop remains
   * testable without a logger fixture.
   */
  logger?: Logger;
  /**
   * Phase 2.5 cost telemetry: called once per iteration when the `done`
   * event carries usage stats. Fires AFTER the logger.info call so the
   * UI can subscribe without parsing the log file. Optional so the loop
   * remains testable without a cost subscriber.
   */
  onCostEstimate?: (breakdown: CostBreakdown) => void;
  /**
   * Phase 2.5 caveman: mutable shared reference created at boot.
   * Passed to engine.prepareRequest each turn so the current active state
   * is read fresh — a `/caveman` slash command that mutates state.active
   * takes effect on the very next prepareRequest call.
   */
  cavemanState?: CavemanState;
};

export async function* runReactLoop(opts: ReactLoopOptions): AsyncIterable<StreamEvent> {
  const maxIters = opts.maxIterations ?? 25;
  const artifactThreshold = opts.artifactThresholdBytes ?? 4096;

  for (let iter = 0; iter < maxIters; iter++) {
    // Pro if EITHER (a) first iteration (planning bias) OR (b) any prior
    // tool-call assistant turn carried reasoning_content (R2 ratchet).
    // Condition (b) becomes permanently true once set — R2 never strips
    // reasoning from tool-call turns — giving the monotonic Pro-lock
    // property described in spec §4.1.3.
    const role: SporeRole =
      iter === 0 || opts.engine.hasRetainedReasoning() ? 'repl-with-reasoning' : 'repl-execution';
    const model = opts.model ?? roleToModel(role);

    opts.logger?.info({ event: 'request_started', role, model, iter });

    const request = opts.engine.prepareRequest({
      model,
      tools: opts.tools.definitions(),
      thinking: true,
      strict: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.cavemanState !== undefined ? { cavemanState: opts.cavemanState } : {}),
    });

    let assistantContent = '';
    let assistantReasoning = '';
    const pendingCalls: ToolCall[] = [];

    for await (const ev of opts.client.stream(request)) {
      yield ev;
      if (isGermination(ev)) continue;
      switch (ev.type) {
        case 'reasoning_delta':
          assistantReasoning += ev.text;
          break;
        case 'content_delta':
          assistantContent += ev.text;
          break;
        case 'tool_call':
          pendingCalls.push({ id: ev.id, name: ev.name, args: ev.args });
          break;
        case 'done': {
          // Phase 2.5: emit cost telemetry whenever usage is present.
          // `done.usage` is always populated (zero-filled on upstream omission)
          // per the DeepSeekClient contract; check that tokens are non-zero so
          // we don't log a meaningless $0.00 entry on mid-stream error cutoffs
          // that zero-fill the usage block.
          const u = ev.usage;
          if (u.promptTokens > 0 || u.completionTokens > 0) {
            const usageStats = {
              inputTokens: u.promptTokens,
              outputTokens: u.completionTokens,
              ...(u.cacheHitTokens !== undefined ? { cachedInputTokens: u.cacheHitTokens } : {}),
            };
            const breakdown = calculateCost(model, usageStats);
            opts.logger?.info({
              event: 'cost_estimated',
              role,
              model,
              iter,
              inputTokens: u.promptTokens,
              outputTokens: u.completionTokens,
              cachedInputTokens: u.cacheHitTokens ?? 0,
              inputCost: breakdown.inputCost,
              outputCost: breakdown.outputCost,
              cacheHitCost: breakdown.cacheHitCost,
              totalCost: breakdown.totalCost,
            });
            opts.onCostEstimate?.(breakdown);
          }
          break;
        }
        case 'error':
        case 'turn_complete':
        case 'tool_result':
        case 'system_message':
        case 'subagent_step':
          break;
      }
    }

    // Append the assistant turn BEFORE the early return so history captures terminal turns.
    opts.engine.appendAssistant({
      content: assistantContent,
      ...(assistantReasoning && pendingCalls.length > 0
        ? { reasoning_content: assistantReasoning }
        : {}),
      ...(pendingCalls.length > 0 ? { tool_calls: pendingCalls } : {}),
    });

    if (pendingCalls.length === 0) return; // Terminal turn.

    // F4: signal the boundary between ReAct turns so consumers (UI) can reset
    // per-turn state (reasoning text, started-at timestamp). Yielded BEFORE
    // tool execution so the UI sees the transition immediately, not after the
    // potentially-slow tool work. The next iteration's reasoning_delta then
    // arrives with a clean per-turn buffer.
    yield { type: 'turn_complete' };

    for (const call of pendingCalls) {
      const startedAt = Date.now();
      try {
        const rawContent = await opts.tools.invoke(call.name, call.args, {
          cwd: opts.cwd ?? process.cwd(),
          toolUseId: call.id,
          ...(opts.signal ? { abort: opts.signal } : {}),
        });
        const durationMs = Date.now() - startedAt;

        // Directive #4: offload oversized results to artifact store.
        let content: string;
        if (opts.artifactStore) {
          const result = await opts.artifactStore.storeArtifact(rawContent, {
            maxBytes: artifactThreshold,
          });
          if (typeof result === 'string') {
            content = result;
          } else {
            // ArtifactPointer — build the compact pointer summary the LLM will see.
            content =
              `[artifact:${result.id}] ${result.bytes} bytes stored at ${result.path}\n` +
              `preview: ${result.preview}`;
          }
        } else {
          content = rawContent;
        }

        opts.engine.appendToolResult({
          tool_use_id: call.id,
          command: `${call.name} ${JSON.stringify(call.args)}`,
          is_error: false,
          content,
        });

        // Redact the preview before it reaches the UI: the preview field is
        // user-visible in the TUI, so it deserves the same R11 treatment as
        // egress payloads. F1 only redacts at `serializeMessage`; this is a
        // separate UI-channel application of the same primitive.
        yield {
          type: 'tool_result',
          id: call.id,
          status: 'completed',
          durationMs,
          ...(rawContent.length > 0 ? { preview: redactSecrets(rawContent.slice(0, 200)) } : {}),
        } satisfies StreamEvent;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        // Cross-module string contract: src/tools/bash.ts createBashTool throws
        // with 'HITL rejected:' prefix on HITL veto. Detect it here to yield
        // status='rejected' (magenta UI state) instead of status='failed' (red).
        const isRejection = err instanceof Error && err.message.startsWith('HITL rejected:');
        opts.engine.appendToolResult({
          tool_use_id: call.id,
          command: `${call.name} ${JSON.stringify(call.args)}`,
          is_error: true,
          content: err instanceof Error ? err.message : String(err),
        });
        yield {
          type: 'tool_result',
          id: call.id,
          status: isRejection ? 'rejected' : 'failed',
          durationMs,
          cause: err,
        } satisfies StreamEvent;
      }
    }
  }

  yield {
    type: 'error',
    cause: new Error(`ReAct loop exceeded maxIterations=${maxIters}`),
  };
}
