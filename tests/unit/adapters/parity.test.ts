/**
 * Cross-adapter parity test (R1 contract enforcer).
 *
 * Asserts that V3Adapter and V4Adapter produce equivalent canonical StreamEvent
 * sequences for semantically equivalent inputs, despite entirely different wire
 * formats (V3: JSON tool_calls; V4: DSML markup in content deltas).
 *
 * If any test here fails, an adapter has diverged from the R1 contract.
 * Fix the offending adapter — never adjust these assertions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { V3Adapter } from '../../../src/adapters/v3/adapter.js';
import { V4Adapter } from '../../../src/adapters/v4/adapter.js';

const enc = new TextEncoder();

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const baseReq: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'test' }],
  thinking: true,
  strict: true,
};

// ── Spec test (verbatim from the plan) ────────────────────────────────────────

async function* v3SpecFixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"ls","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

async function* v4SpecFixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls><call id=\\"t1\\" name=\\"ls\\"><param key=\\"path\\" string=\\"true\\">.</param></call></|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

const specReq: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'list cwd' }],
  thinking: true,
  strict: true,
};

describe('V3 / V4 adapter parity (R1)', () => {
  it('both emit the same canonical sequence of event types and same tool_call shape', async () => {
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3SpecFixture()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4SpecFixture()),
    });
    const v3Events = await collect(v3.stream(specReq));
    const v4Events = await collect(v4.stream(specReq));
    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));
    const v3Tool = v3Events.find((e) => e.type === 'tool_call');
    const v4Tool = v4Events.find((e) => e.type === 'tool_call');
    expect(v3Tool).toMatchObject({ name: 'ls', args: { path: '.' } });
    expect(v4Tool).toMatchObject({ name: 'ls', args: { path: '.' } });
  });

  // ── Adversarial test A: content-only response (no tool calls) ────────────────
  // Catches: V4 DSML parser accidentally emitting tool_call events for plain content.
  it('A — content-only response: both produce [content_delta, done] with no tool_call', async () => {
    async function* v3Content(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4Content(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3Content()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4Content()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    // Both must produce same event types in same order.
    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));
    // Neither should have produced tool_call events.
    expect(v3Events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(v4Events.some((e) => e.type === 'tool_call')).toBe(false);
    // Both must terminate with done.
    expect(v3Events.at(-1)?.type).toBe('done');
    expect(v4Events.at(-1)?.type).toBe('done');
    // Both must emit the content text.
    const v3Text = v3Events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta',
      )
      .map((e) => e.text)
      .join('');
    const v4Text = v4Events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta',
      )
      .map((e) => e.text)
      .join('');
    expect(v3Text).toBe('hello world');
    expect(v4Text).toBe('hello world');
  });

  // ── Adversarial test B: multiple tool calls in one response ──────────────────
  // Catches: V3 index-tracking or V4 multi-<call> parsing producing different counts.
  it('B — multiple tool calls: both produce two tool_call events with matching ids/names/args', async () => {
    async function* v3Multi(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n',
        // Tool call 0 — name+id in first delta, args in second.
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
        // Tool call 1 — all in one delta.
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"write","arguments":"{\\"path\\":\\"b.txt\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4Multi(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n',
        // Both calls in one DSML block, split across two content deltas.
        'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls><call id=\\"c1\\" name=\\"read\\"><param key=\\"path\\" string=\\"true\\">a.txt</param></call>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<call id=\\"c2\\" name=\\"write\\"><param key=\\"path\\" string=\\"true\\">b.txt</param></call></|DSML|tool_calls>"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3Multi()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4Multi()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));

    const v3Tools = v3Events.filter(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    const v4Tools = v4Events.filter(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(v3Tools).toHaveLength(2);
    expect(v4Tools).toHaveLength(2);

    // Both adapters must emit the same tool calls (order-insensitive by id).
    const normalize = (tools: typeof v3Tools) =>
      [...tools].sort((a, b) => a.id.localeCompare(b.id));
    expect(normalize(v3Tools)).toMatchObject([
      { id: 'c1', name: 'read', args: { path: 'a.txt' } },
      { id: 'c2', name: 'write', args: { path: 'b.txt' } },
    ]);
    expect(normalize(v4Tools)).toMatchObject([
      { id: 'c1', name: 'read', args: { path: 'a.txt' } },
      { id: 'c2', name: 'write', args: { path: 'b.txt' } },
    ]);
  });

  // ── Adversarial test C: structured (non-string) args ────────────────────────
  // Catches: V4 string="false" parsing failing to produce the same JS value as
  // V3's JSON.parse of the arguments string.
  it('C — structured args: both parse array/object/number args identically', async () => {
    // args: { items: [1, 2, 3], count: 42, enabled: false }
    async function* v3Structured(): AsyncIterable<Uint8Array> {
      const args = JSON.stringify({ items: [1, 2, 3], count: 42, enabled: false });
      const escaped = args.replace(/"/g, '\\"');
      const lines = [
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"s1","function":{"name":"batch","arguments":"${escaped}"}}]}}]}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4Structured(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls><call id=\\"s1\\" name=\\"batch\\"><param key=\\"items\\" string=\\"false\\">[1,2,3]</param><param key=\\"count\\" string=\\"false\\">42</param><param key=\\"enabled\\" string=\\"false\\">false</param></call></|DSML|tool_calls>"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3Structured()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4Structured()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));

    const v3Tool = v3Events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    const v4Tool = v4Events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(v3Tool).toMatchObject({
      id: 's1',
      name: 'batch',
      args: { items: [1, 2, 3], count: 42, enabled: false },
    });
    expect(v4Tool).toMatchObject({
      id: 's1',
      name: 'batch',
      args: { items: [1, 2, 3], count: 42, enabled: false },
    });
  });

  // ── Adversarial test D: string args with XML/JSON special characters ─────────
  // Catches: V4 XML-entity unescaping failure or V3 JSON-escape handling diverging.
  // This is the cross-adapter validation of the Phase-3 escape-contract fix.
  it('D — special chars in string args: both reproduce <, >, ", & faithfully', async () => {
    const specialValue = 'a < b AND c > d & "quoted"';
    // V3 wire: use JSON.stringify on the entire SSE object to get correct escaping.
    const v3ArgStr = JSON.stringify({ query: specialValue });
    // V4 wire: XML-entity-escaped in param body.
    const v4XmlEscaped = specialValue
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    async function* v3Special(): AsyncIterable<Uint8Array> {
      // Build SSE chunks using JSON.stringify on the whole object to handle all escaping.
      const chunk1 = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'sp1', function: { name: 'search', arguments: v3ArgStr } },
              ],
            },
          },
        ],
      });
      const chunk2 = JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      });
      const lines = [`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, 'data: [DONE]\n\n'];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4Special(): AsyncIterable<Uint8Array> {
      const contentStr = `<|DSML|tool_calls><call id="sp1" name="search"><param key="query" string="true">${v4XmlEscaped}</param></call></|DSML|tool_calls>`;
      const chunk1 = JSON.stringify({ choices: [{ delta: { content: contentStr } }] });
      const chunk2 = JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      });
      const lines = [`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, 'data: [DONE]\n\n'];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3Special()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4Special()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));

    const v3Tool = v3Events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    const v4Tool = v4Events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(v3Tool).toMatchObject({ id: 'sp1', name: 'search', args: { query: specialValue } });
    expect(v4Tool).toMatchObject({ id: 'sp1', name: 'search', args: { query: specialValue } });
  });

  // ── Adversarial test E: reasoning interspersed with content delta ────────────
  // Catches: event ordering divergence when both adapters handle mixed
  // reasoning_content and content delta fields.
  it('E — reasoning + content interleaved: both produce same event order', async () => {
    async function* v3Mixed(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking step 1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part 1"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking step 2"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part 2"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4Mixed(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking step 1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part 1"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking step 2"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part 2"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3Mixed()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4Mixed()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    // Exact event type sequence must match.
    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));
    // Expected: reasoning, content, reasoning, content, done.
    expect(v3Events.map((e) => e.type)).toEqual([
      'reasoning_delta',
      'content_delta',
      'reasoning_delta',
      'content_delta',
      'done',
    ]);
    // Reasoning text must match.
    const v3Reasoning = v3Events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'reasoning_delta' }> => e.type === 'reasoning_delta',
      )
      .map((e) => e.text);
    const v4Reasoning = v4Events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'reasoning_delta' }> => e.type === 'reasoning_delta',
      )
      .map((e) => e.text);
    expect(v3Reasoning).toEqual(v4Reasoning);
    expect(v3Reasoning).toEqual(['thinking step 1', 'thinking step 2']);
  });

  // ── Adversarial test F: pre-stream connection failure ────────────────────────
  // Catches: one adapter throwing instead of yielding error event.
  it('F — pre-stream failure: both yield [{type:"error"}] and terminate without throwing', async () => {
    const connErr = new Error('ECONNREFUSED');
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockRejectedValue(connErr),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockRejectedValue(connErr),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    expect(v3Events.map((e) => e.type)).toEqual(['error']);
    expect(v4Events.map((e) => e.type)).toEqual(['error']);
    // Type-level match — don't compare cause shapes across adapters.
    expect(v3Events[0]?.type).toBe('error');
    expect(v4Events[0]?.type).toBe('error');
  });

  // ── Adversarial test G: terminal finish_reason without usage ────────────────
  // Catches: one adapter failing to emit done when usage is absent (Phase-2 lesson).
  it('G — missing usage on terminal chunk: both emit done with zero-filled usage', async () => {
    async function* v3NoUsage(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"u1","function":{"name":"noop","arguments":"{}"}}]}}]}\n\n',
        // Terminal chunk with no usage field at all.
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    async function* v4NoUsage(): AsyncIterable<Uint8Array> {
      const lines = [
        'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls><call id=\\"u1\\" name=\\"noop\\"></call></|DSML|tool_calls>"}}]}\n\n',
        // Terminal chunk with no usage field at all.
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      for (const l of lines) yield enc.encode(l);
    }
    const v3 = new V3Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v3NoUsage()),
    });
    const v4 = new V4Adapter({
      apiKey: 'k',
      baseUrl: 'x',
      openSse: vi.fn().mockResolvedValue(v4NoUsage()),
    });
    const v3Events = await collect(v3.stream(baseReq));
    const v4Events = await collect(v4.stream(baseReq));

    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));

    const v3Done = v3Events.find(
      (e): e is Extract<StreamEvent, { type: 'done' }> => e.type === 'done',
    );
    const v4Done = v4Events.find(
      (e): e is Extract<StreamEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(v3Done).toBeDefined();
    expect(v4Done).toBeDefined();
    // Both must zero-fill missing usage fields.
    expect(v3Done?.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
    expect(v4Done?.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });
});
