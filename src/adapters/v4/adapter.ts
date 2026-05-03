import { redactJsonLeaves, redactSecrets } from '../../security/redactor.js';
import { openSseConnection, parseSseStream } from '../../transport/sseClient.js';
import type { FetchInit } from '../../transport/sseClient.js';
import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { Message } from '../messages.js';
import type { StreamEvent } from '../streamEvent.js';
import { DsmlParser, escapeXml } from './dsmlParser.js';

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
 *
 * R11: every outbound payload is run through `redactSecrets` before transmission.
 * Tool-call args are leaf-redacted **before** DSML assembly so the env_value
 * pattern's greedy `\S+` cannot run past a `</param>` close marker and corrupt
 * the wire shape. The prefix `m.content` and `reasoning_content` are redacted
 * as plain strings; tool result `content` is redacted on egress.
 */
export function serializeMessage(m: Message): unknown {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: redactSecrets(m.content) };
    case 'assistant': {
      const prefix = m.content === null ? null : redactSecrets(m.content);
      const out: Record<string, unknown> = { role: 'assistant', content: prefix };
      if (m.reasoning_content) out.reasoning_content = redactSecrets(m.reasoning_content);
      if (m.tool_calls) {
        // V4 expects historical tool_calls re-serialized as DSML markup in content
        // for context continuity. This differs from V3 which uses a tool_calls array.
        // Attribute values escaped to keep markup well-formed for arbitrary names/ids.
        const dsml = `<|DSML|tool_calls>${m.tool_calls
          .map(
            (tc) =>
              `<call id="${escapeXml(tc.id)}" name="${escapeXml(tc.name)}">${serializeArgs(redactJsonLeaves(tc.args))}</call>`,
          )
          .join('')}</|DSML|tool_calls>`;
        out.content = `${prefix ?? ''}${dsml}`;
      }
      return out;
    }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: m.result.tool_use_id,
        content: redactSecrets(m.result.content),
      };
  }
}

/**
 * Serialises tool call args as DSML param tags.
 * Strings get `string="true"` and raw value; everything else gets `string="false"` and JSON.stringify.
 *
 * All values and attribute strings are XML-escaped so that `<`, `>`, `&`, `"`, `'`
 * inside user data round-trip through the parser losslessly. The parser unescapes
 * symmetrically. See `dsmlParser.escapeXml`/`unescapeXml`.
 */
export function serializeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      const isString = typeof v === 'string';
      const rawValue = isString ? (v as string) : JSON.stringify(v);
      return `<param key="${escapeXml(k)}" string="${isString}">${escapeXml(rawValue)}</param>`;
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
    // F6: persist a second DsmlParser for the reasoning channel. Stateless
    // detectLeakedDsml() short-circuited whenever a single chunk lacked either
    // marker, so DSML markup that legitimately leaked into reasoning_content
    // and was split across SSE deltas fell through to raw passthrough — the
    // markup leaked into user-visible reasoning, and the tool call was lost.
    // The content channel already does this correctly; symmetric treatment for
    // reasoning closes the gap.
    const dsmlReasoning = new DsmlParser();

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
          // F6: route reasoning_content through a persistent DsmlParser. The
          // parser emits content-channel events; remap content_delta to
          // reasoning_delta, pass tool_call through verbatim. Cross-chunk DSML
          // leaks now buffer correctly inside the parser instead of falling
          // through to raw passthrough as the previous stateless
          // detectLeakedDsml call did.
          for (const e of dsmlReasoning.feed(delta.reasoning_content)) {
            if (e.type === 'content_delta') yield { type: 'reasoning_delta', text: e.text };
            else yield e; // tool_call passes through
          }
        }

        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          // Content carries DSML tool call markup — feed through the state machine.
          for (const e of dsml.feed(delta.content)) yield e;
        }

        const finish = choice?.finish_reason;
        // Phase-2 lesson: always emit done for ANY terminal finish_reason; zero-fill usage.
        if (typeof finish === 'string' && TERMINAL_FINISH_REASONS.has(finish)) {
          // Drain any content-mode tail bytes the safe-prefix logic withheld. At
          // terminal finish, those bytes can't be a partial OPEN_BLOCK any more.
          for (const e of dsml.flush()) yield e;
          // F6: drain the reasoning channel symmetrically.
          for (const e of dsmlReasoning.flush()) {
            if (e.type === 'content_delta') yield { type: 'reasoning_delta', text: e.text };
            else yield e;
          }
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
