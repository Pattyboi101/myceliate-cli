import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { V3Adapter } from '../../../src/adapters/v3/adapter.js';

const encoder = new TextEncoder();

async function* sseFixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield encoder.encode(l);
}

describe('V3Adapter', () => {
  it('streams canonical events end-to-end via injected SSE opener', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({
      apiKey: 'sk-test',
      baseUrl: 'https://api.test',
      openSse: opener,
    });
    const events: StreamEvent[] = [];
    for await (const e of adapter.stream({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: true,
      strict: true,
    }))
      events.push(e);
    expect(events.map((e) => e.type)).toEqual(['reasoning_delta', 'content_delta', 'done']);
    expect(opener).toHaveBeenCalledOnce();
    const sentBody = opener.mock.calls[0]![0].body as { stream: boolean; messages: unknown[] };
    expect(sentBody.stream).toBe(true);
  });

  it('exposes id "v3"', () => {
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn() });
    expect(adapter.id).toBe('v3');
  });
});
