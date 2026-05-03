import { redactJsonLeaves, redactSecrets } from '../../security/redactor.js';
import { openSseConnection, parseSseStream } from '../../transport/sseClient.js';
import type { FetchInit } from '../../transport/sseClient.js';
import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { Message } from '../messages.js';
import type { StreamEvent } from '../streamEvent.js';
import { V3StreamState, parseV3Chunk } from './parser.js';

type SseOpener = (init: FetchInit) => Promise<AsyncIterable<Uint8Array>>;

export type V3AdapterOptions = {
  apiKey: string;
  baseUrl: string;
  openSse?: SseOpener;
};

export class V3Adapter implements DeepSeekClient {
  readonly id = 'v3' as const;
  private readonly opener: SseOpener;

  constructor(private readonly opts: V3AdapterOptions) {
    this.opener = opts.openSse ?? openSseConnection;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = buildRequestBody(req);

    let byteStream: AsyncIterable<Uint8Array>;
    try {
      byteStream = await this.opener({
        url: `${this.opts.baseUrl}/v1/chat/completions`,
        body,
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (cause) {
      // Honour the DeepSeekClient contract: the iterator never throws.
      // Pre-stream connection failures (incl. SseConnectionError) surface as events.
      yield { type: 'error', cause };
      return;
    }

    const state = new V3StreamState();
    try {
      for await (const json of parseSseStream(byteStream)) {
        for (const event of parseV3Chunk(state, json)) yield event;
      }
    } catch (cause) {
      // Mid-stream failures (network drop, decode error) also become events.
      yield { type: 'error', cause };
    }
  }
}

function buildRequestBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(serializeMessage),
    stream: true,
    ...(req.tools !== undefined
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: req.strict, // R3 enforced per-function on the V3 wire.
            },
          })),
          tool_choice: 'auto', // v1 always 'auto'; lift to ChatRequest.toolChoice in v2.
        }
      : {}),
    ...(req.options ?? {}),
  };
}

/**
 * Serialises a canonical Message into the OpenAI wire shape that V3 accepts.
 * Top-level export so V4's adapter can reuse it (V4 messages are 80%+ identical;
 * only the assistant body differs in DSML emission).
 *
 * R11: every outbound payload is run through `redactSecrets` before transmission.
 * For tool-call args, redaction is applied per leaf string before JSON.stringify
 * so the wire envelope (quotes, braces) is preserved intact — see `redactJsonLeaves`.
 */
export function serializeMessage(m: Message): unknown {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: redactSecrets(m.content) };
    case 'assistant': {
      const out: Record<string, unknown> = {
        role: 'assistant',
        content: m.content === null ? null : redactSecrets(m.content),
      };
      if (m.reasoning_content) out.reasoning_content = redactSecrets(m.reasoning_content);
      if (m.tool_calls) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(redactJsonLeaves(tc.args)),
          },
        }));
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
