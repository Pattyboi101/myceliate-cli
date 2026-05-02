import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { Message } from '../messages.js';
import type { StreamEvent } from '../streamEvent.js';
import { openSseConnection, parseSseStream, type FetchInit } from '../../transport/sseClient.js';
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
    const body = {
      model: req.model,
      messages: req.messages.map(this.serializeMessage),
      stream: true,
      ...(req.tools !== undefined
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters, strict: req.strict },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(req.options ?? {}),
    };
    const byteStream = await this.opener({
      url: `${this.opts.baseUrl}/v1/chat/completions`,
      body,
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      ...(req.signal ? { signal: req.signal } : {}),
    });

    const state = new V3StreamState();
    for await (const json of parseSseStream(byteStream)) {
      for (const event of parseV3Chunk(state, json)) yield event;
    }
  }

  private serializeMessage = (m: Message): unknown => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        if (m.tool_calls) {
          out.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.result.tool_use_id, content: m.result.content };
    }
  };
}
