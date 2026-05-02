import { openSseConnection, parseSseStream } from '../../transport/sseClient.js';
import type { FetchInit } from '../../transport/sseClient.js';
import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { Message } from '../messages.js';
import type { StreamEvent } from '../streamEvent.js';
import { DsmlParser } from './dsmlParser.js';
import { detectLeakedDsml } from './leakFallback.js';

type SseOpener = (init: FetchInit) => Promise<AsyncIterable<Uint8Array>>;

export type V4AdapterOptions = {
  apiKey: string;
  baseUrl: string;
  openSse?: SseOpener;
};

type V4Chunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
};

// Phase-2 lesson: define all terminal finish reasons (not just stop/tool_calls).
const TERMINAL_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

export function buildRequestBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(serializeMessage),
    stream: true,
    thinking: req.thinking,
    // V4 uses flat tool shape (no nested 'function' wrapper, unlike V3).
    ...(req.tools !== undefined
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: req.strict,
          })),
        }
      : {}),
    ...(req.options ?? {}),
  };
}

/**
 * Serialises a canonical Message into the V4 wire shape.
 * For assistant turns with tool_calls, the tool_calls are re-serialised as
 * DSML markup appended to the content field for V4 context continuity.
 * Top-level export per Phase-2 lesson: helpers are module-level, not instance methods.
 */
export function serializeMessage(m: Message): unknown {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content };
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content };
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      if (m.tool_calls) {
        // V4 expects historical tool_calls re-serialized as DSML markup in content
        // for context continuity. This differs from V3 which uses a tool_calls array.
        const dsml = `<|DSML|tool_calls>${m.tool_calls
          .map((tc) => `<call id="${tc.id}" name="${tc.name}">${serializeArgs(tc.args)}</call>`)
          .join('')}</|DSML|tool_calls>`;
        out.content = `${m.content ?? ''}${dsml}`;
      }
      return out;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.result.tool_use_id, content: m.result.content };
  }
}

/**
 * Serialises tool call args as DSML param tags.
 * Strings get `string="true"` and raw value; everything else gets `string="false"` and JSON.stringify.
 */
export function serializeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      const isString = typeof v === 'string';
      const value = isString ? (v as string) : JSON.stringify(v);
      return `<param key="${k}" string="${isString}">${value}</param>`;
    })
    .join('');
}

export class V4Adapter implements DeepSeekClient {
  readonly id = 'v4' as const;
  private readonly opener: SseOpener;

  constructor(private readonly opts: V4AdapterOptions) {
    this.opener = opts.openSse ?? openSseConnection;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = buildRequestBody(req);

    // Phase-2 lesson: pre-stream failure is wrapped to yield error event, not throw.
    let byteStream: AsyncIterable<Uint8Array>;
    try {
      byteStream = await this.opener({
        url: `${this.opts.baseUrl}/v1/chat/completions`,
        body,
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (cause) {
      yield { type: 'error', cause };
      return;
    }

    const dsml = new DsmlParser();

    // Phase-2 lesson: mid-stream failure is caught and yields error event, not throw.
    try {
      for await (const json of parseSseStream(byteStream)) {
        let chunk: V4Chunk;
        try {
          chunk = JSON.parse(json) as V4Chunk;
        } catch (cause) {
          // Phase-2 lesson: pass cause through as unknown — do not wrap in new Error().
          yield { type: 'error', cause };
          continue;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        // Phase-2 lesson: explicit string length check instead of truthy (avoids dropping empty strings).
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          // Wire through leak fallback for vLLM/NIM servers that leak DSML into reasoning_content.
          const { cleanedText, toolCalls } = detectLeakedDsml(delta.reasoning_content);
          if (cleanedText.length > 0) yield { type: 'reasoning_delta', text: cleanedText };
          for (const tc of toolCalls)
            yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args };
        }

        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          // Content carries DSML tool call markup — feed through the state machine.
          for (const e of dsml.feed(delta.content)) yield e;
        }

        const finish = choice?.finish_reason;
        // Phase-2 lesson: always emit done for ANY terminal finish_reason; zero-fill usage.
        if (typeof finish === 'string' && TERMINAL_FINISH_REASONS.has(finish)) {
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
    } catch (cause) {
      yield { type: 'error', cause };
    }
  }
}
