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

  if (delta?.reasoning_content) {
    yield { type: 'reasoning_delta', text: delta.reasoning_content };
  }
  if (delta?.content) {
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

  if (choice?.finish_reason === 'tool_calls') {
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
      yield { type: 'tool_call', id: pending.id, name: pending.name, args };
    }
    state.pending.clear();
  }

  if (
    chunk.usage !== undefined &&
    (choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls')
  ) {
    yield {
      type: 'done',
      usage: {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        ...(chunk.usage.prompt_cache_hit_tokens !== undefined
          ? { cacheHitTokens: chunk.usage.prompt_cache_hit_tokens }
          : {}),
      },
    };
  }
}
