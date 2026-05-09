// src/orchestrator/reactLoop.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { ToolCall } from '../adapters/messages.js';
import { type StreamEvent, isGermination } from '../adapters/streamEvent.js';
import type { MarkdownStore } from '../memory/markdownStore.js';
import { type SporeRole, roleToModel } from '../runtime/roleToModel.js';
import { redactSecrets } from '../security/redactor.js';
import type { ToolRegistry } from '../tools/registry.js';
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
};

export async function* runReactLoop(opts: ReactLoopOptions): AsyncIterable<StreamEvent> {
  const maxIters = opts.maxIterations ?? 25;
  const artifactThreshold = opts.artifactThresholdBytes ?? 4096;

  for (let iter = 0; iter < maxIters; iter++) {
    // Iteration 0 always Pro (planning bias — see spec §4.1.3); subsequent
    // iterations ratchet on retained reasoning_content per R2. Once Pro,
    // stays Pro within the session (monotonic rule).
    const role: SporeRole =
      iter === 0 || opts.engine.hasRetainedReasoning() ? 'repl-with-reasoning' : 'repl-execution';
    const model = opts.model ?? roleToModel(role);

    const request = opts.engine.prepareRequest({
      model,
      tools: opts.tools.definitions(),
      thinking: true,
      strict: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
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
        case 'done':
        case 'error':
        case 'turn_complete':
        case 'tool_result':
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
