import type { StreamEvent } from '../streamEvent.js';

type PendingToolCall = {
  id: string;
  name: string;
  argsBuffer: string;
};

export class V3StreamState {
  pending = new Map<number, PendingToolCall>();
}

type V3DeltaChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
};

const TERMINAL_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

export function* parseV3Chunk(state: V3StreamState, json: string): Generator<StreamEvent> {
  let chunk: V3DeltaChunk;
  try {
    chunk = JSON.parse(json) as V3DeltaChunk;
  } catch (cause) {
    // StreamEvent.error.cause is `unknown`; pass through without lossy wrapping.
    yield { type: 'error', cause };
    return;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;

  // Pass through non-empty reasoning/content fragments. Empty strings are dropped
  // deliberately (they're stream punctuation, not user-visible content).
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    yield { type: 'reasoning_delta', text: delta.reasoning_content };
  }
  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    yield { type: 'content_delta', text: delta.content };
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = state.pending.get(tc.index);
      if (existing === undefined) {
        state.pending.set(tc.index, {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          argsBuffer: tc.function?.arguments ?? '',
        });
      } else {
        if (tc.id !== undefined) existing.id = tc.id;
        if (tc.function?.name !== undefined) existing.name = tc.function.name;
        if (tc.function?.arguments !== undefined) existing.argsBuffer += tc.function.arguments;
      }
    }
  }

  const finish = choice?.finish_reason;
  if (typeof finish === 'string' && TERMINAL_FINISH_REASONS.has(finish)) {
    // Flush accumulated tool_calls regardless of finish_reason. OpenAI's wire
    // contract pairs them with `finish_reason: 'tool_calls'`, but real upstreams
    // sometimes finish with `'stop'` despite having emitted tool deltas; silently
    // dropping intent is worse than yielding what we have.
    for (const pending of state.pending.values()) {
      let args: unknown = {};
      try {
        args = JSON.parse(pending.argsBuffer || '{}');
      } catch (cause) {
        // Wrap to add context, but preserve the original cause via Error.cause.
        yield {
          type: 'error',
          cause: new Error(`Tool call args JSON parse failed: ${pending.argsBuffer}`, { cause }),
        };
        continue;
      }
      // args is intentionally `unknown` here; per CLAUDE.md, the orchestrator
      // performs Zod validation at the tool-dispatch boundary, not the adapter.
      yield { type: 'tool_call', id: pending.id, name: pending.name, args };
    }
    state.pending.clear();

    // Always emit a terminal `done` event so the consumer's `for await` loop
    // can rely on it. Zero-fill usage if upstream omits it (mid-stream cutoff,
    // upstream variants).
    const u = chunk.usage;
    yield {
      type: 'done',
      usage: {
        promptTokens: u?.prompt_tokens ?? 0,
        completionTokens: u?.completion_tokens ?? 0,
        reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
        ...(u?.prompt_cache_hit_tokens !== undefined
          ? { cacheHitTokens: u.prompt_cache_hit_tokens }
          : {}),
      },
    };
  }
}
