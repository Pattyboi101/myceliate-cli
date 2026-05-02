import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/adapters/DeepSeekClient.js';
import { V4Adapter } from '../../../src/adapters/v4/adapter.js';

const enc = new TextEncoder();

async function* fixture(): AsyncIterable<Uint8Array> {
  // V4 SSE: each chunk has {choices:[{delta:{reasoning_content?, content?}}]}.
  // Tool calls arrive as DSML markup inside content.
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"plan: read"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<call id=\\"t1\\" name=\\"read_file\\">"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<param key=\\"path\\" string=\\"true\\">a.txt</param>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"</call></|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"completion_tokens_details":{"reasoning_tokens":4}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

async function collect(
  it: AsyncIterable<import('../../../src/adapters/streamEvent.js').StreamEvent>,
) {
  const out = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('V4Adapter', () => {
  // ── Spec test 1: DSML tool calls in SSE ───────────────────────────────────
  it('parses DSML tool calls embedded in SSE content frames', async () => {
    const adapter = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(fixture()),
    });
    const events = [];
    for await (const e of adapter.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read a.txt' }],
      thinking: true,
      strict: true,
    }))
      events.push(e);
    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'plan: read' });
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't1',
      name: 'read_file',
      args: { path: 'a.txt' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  // ── Spec test 2: adapter id ────────────────────────────────────────────────
  it('exposes id "v4"', () => {
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn() });
    expect(adapter.id).toBe('v4');
  });

  // ── Phase-2-lesson: wire shape (URL, auth, tools, thinking) ───────────────
  it('builds wire shape with flat tools, strict flag, URL, and auth header', async () => {
    const opener = vi.fn().mockResolvedValue(fixture());
    const adapter = new V4Adapter({
      apiKey: 'sk-test',
      baseUrl: 'https://api.test',
      openSse: opener,
    });
    const tool: ToolDefinition = {
      name: 'read_file',
      description: 'read a UTF-8 file',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    };
    await collect(
      adapter.stream({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'go' }],
        tools: [tool],
        thinking: true,
        strict: true,
      }),
    );
    const call = opener.mock.calls[0]?.[0];
    expect(call.url).toBe('https://api.test/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-test');
    const body = call.body as { thinking: boolean; tools: unknown[] };
    expect(body.thinking).toBe(true);
    // V4 uses FLAT tools (no nested 'function' wrapper), unlike V3.
    expect(body.tools).toEqual([
      {
        name: 'read_file',
        description: 'read a UTF-8 file',
        parameters: tool.parameters,
        strict: true,
      },
    ]);
  });

  // ── Phase-2-lesson: assistant message serialisation with DSML re-emission ──
  it('serialises assistant tool-call history as DSML re-emission in content', async () => {
    const opener = vi.fn().mockResolvedValue(fixture());
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    await collect(
      adapter.stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'thinking',
            reasoning_content: 'plan',
            tool_calls: [{ id: 't1', name: 'x', args: { k: 'v' } }],
          },
          {
            role: 'tool',
            result: { tool_use_id: 't1', command: 'x', is_error: false, content: 'ok' },
          },
        ],
        thinking: true,
        strict: true,
      }),
    );
    const messages = (opener.mock.calls[0]?.[0].body as { messages: unknown[] }).messages;
    const assistantMsg = messages[1] as {
      role: string;
      content: string;
      reasoning_content: string;
    };
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.reasoning_content).toBe('plan');
    // DSML re-emission: tool_calls are serialised into the content string.
    expect(assistantMsg.content).toContain('<|DSML|tool_calls>');
    expect(assistantMsg.content).toContain('<call id="t1" name="x">');
    expect(assistantMsg.content).toContain('<param key="k" string="true">v</param>');
    expect(assistantMsg.content).toContain('</call>');
    expect(assistantMsg.content).toContain('</|DSML|tool_calls>');
    // Tool result message.
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
  });

  // ── Phase-2-lesson: iterator-never-throws — pre-stream failure ────────────
  it('yields error event (not throws) when opener rejects', async () => {
    const opener = vi.fn().mockRejectedValue(new Error('connection refused'));
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const events = await collect(
      adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
        strict: true,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect((events[0].cause as Error).message).toBe('connection refused');
    }
  });

  // ── Phase-2-lesson: iterator-never-throws — mid-stream failure ─────────────
  it('yields content then error event on mid-stream failure', async () => {
    async function* throwingStream(): AsyncIterable<Uint8Array> {
      yield enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      throw new Error('socket reset');
    }
    const opener = vi.fn().mockResolvedValue(throwingStream());
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const events = await collect(
      adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
        strict: true,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['content_delta', 'error']);
  });

  // ── Leak fallback wired through delta.reasoning_content ────────────────────
  it('extracts tool calls leaked into reasoning_content (vLLM/NIM rescue)', async () => {
    async function* leakedStream(): AsyncIterable<Uint8Array> {
      // Upstream middleware bug: DSML markers leaked into reasoning_content rather than
      // being stripped to a structured tool_calls field.
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"plan <|DSML|tool_calls><call id=\\"t\\" name=\\"ls\\"></call></|DSML|tool_calls> done"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const opener = vi.fn().mockResolvedValue(leakedStream());
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const events = await collect(
      adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
        strict: true,
      }),
    );
    expect(events).toContainEqual({
      type: 'reasoning_delta',
      text: 'plan  done',
    });
    expect(events).toContainEqual({ type: 'tool_call', id: 't', name: 'ls', args: {} });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  // ── Parser flush at terminal finish — drain content-mode tail ──────────────
  it('drains the DSML parser content-mode tail at terminal finish_reason', async () => {
    async function* taillyStream(): AsyncIterable<Uint8Array> {
      // Content ends with bytes that *could* start an OPEN_BLOCK (`<|D`).
      // Without a flush, those bytes get withheld forever.
      const lines = [
        'data: {"choices":[{"delta":{"content":"hello tail<|D"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const opener = vi.fn().mockResolvedValue(taillyStream());
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const events = await collect(
      adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
        strict: true,
      }),
    );
    const contentTexts = events
      .filter((e): e is Extract<typeof e, { type: 'content_delta' }> => e.type === 'content_delta')
      .map((e) => e.text);
    expect(contentTexts.join('')).toBe('hello tail<|D');
  });

  // ── Round-trip: assistant DSML re-emission parses back to original args ────
  it('serialised assistant tool_calls round-trip through the parser', async () => {
    const opener = vi.fn().mockResolvedValue(fixture());
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const args = { sql: 'a < b AND c > d', tag: '<div class="x">y</div>', n: 7 };
    await collect(
      adapter.stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: null, tool_calls: [{ id: 't&1', name: 'q<x>', args }] },
        ],
        thinking: true,
        strict: true,
      }),
    );
    const messages = (opener.mock.calls[0]?.[0].body as { messages: { content: string }[] })
      .messages;
    const assistantContent = messages[1]?.content ?? '';
    // Round-trip: feed the wire shape back through the parser.
    const { DsmlParser } = await import('../../../src/adapters/v4/dsmlParser.js');
    const events = new DsmlParser().feed(assistantContent);
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't&1',
      name: 'q<x>',
      args,
    });
  });
});
