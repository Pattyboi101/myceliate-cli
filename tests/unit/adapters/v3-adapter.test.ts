import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/adapters/DeepSeekClient.js';
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

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('V3Adapter', () => {
  it('streams canonical events end-to-end via injected SSE opener', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({
      apiKey: 'sk-test',
      baseUrl: 'https://api.test',
      openSse: opener,
    });
    const events = await collect(
      adapter.stream({
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
        strict: true,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['reasoning_delta', 'content_delta', 'done']);
    expect(opener).toHaveBeenCalledOnce();
    const sentBody = opener.mock.calls[0]?.[0].body as { stream: boolean; messages: unknown[] };
    expect(sentBody.stream).toBe(true);
  });

  it('exposes id "v3"', () => {
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn() });
    expect(adapter.id).toBe('v3');
  });

  it('builds the wire request with strict per-function (R3), tool_choice, auth header, and full URL', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({
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
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'go' }],
        tools: [tool],
        thinking: true,
        strict: true,
      }),
    );
    const call = opener.mock.calls[0]?.[0];
    expect(call.url).toBe('https://api.test/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-test');
    const body = call.body as { tools: unknown[]; tool_choice: string };
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'read a UTF-8 file',
          parameters: tool.parameters,
          strict: true,
        },
      },
    ]);
  });

  it('serialises assistant tool-call turns with stringified arguments', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    await collect(
      adapter.stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'planning',
            tool_calls: [{ id: 't1', name: 'read_file', args: { path: 'a.txt' } }],
          },
          {
            role: 'tool',
            result: { tool_use_id: 't1', command: 'read_file', is_error: false, content: 'OK' },
          },
        ],
        thinking: true,
        strict: true,
      }),
    );
    const messages = (opener.mock.calls[0]?.[0].body as { messages: unknown[] }).messages;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'planning',
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'OK' });
  });

  it('surfaces pre-stream connection failures as an error event (iterator never throws)', async () => {
    const opener = vi.fn().mockRejectedValue(new Error('connection refused'));
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
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

  it('surfaces mid-stream failures as an error event', async () => {
    async function* throwingStream(): AsyncIterable<Uint8Array> {
      yield encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      throw new Error('socket reset');
    }
    const opener = vi.fn().mockResolvedValue(throwingStream());
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
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

  // ── R11: egress redaction wired through serializeMessage ──────────────────
  it('redacts secrets in system/user/assistant/tool message content before transmission', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: opener });
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    await collect(
      adapter.stream({
        model: 'm',
        messages: [
          { role: 'system', content: 'creds: sk-proj-abc123def456ghi789jklmnopqrstuvwxyzabc' },
          { role: 'user', content: `token: ${jwt}` },
          {
            role: 'assistant',
            content: 'leaked sk-proj-aaa111bbb222ccc333ddd444eee555fff666',
            reasoning_content: 'planning DATABASE_URL=postgres://u:p@host/db',
            tool_calls: [
              {
                id: 't1',
                name: 'shell',
                args: { cmd: 'echo API_KEY=topsecret123abc' },
              },
            ],
          },
          {
            role: 'tool',
            result: {
              tool_use_id: 't1',
              command: 'shell',
              is_error: false,
              content: 'output: sk-proj-xyz789aaa111bbb222ccc333ddd444eee555',
            },
          },
        ],
        thinking: true,
        strict: true,
      }),
    );
    const messages = (opener.mock.calls[0]?.[0].body as { messages: unknown[] }).messages as Array<
      Record<string, unknown>
    >;
    // System message — openai_key redacted
    expect(messages[0]?.content).not.toContain('sk-proj-abc123');
    expect(messages[0]?.content).toContain('[REDACTED:openai_key]');
    // User message — JWT redacted
    expect(messages[1]?.content).not.toContain(jwt);
    expect(messages[1]?.content).toContain('[REDACTED:jwt]');
    // Assistant content + reasoning_content redacted
    expect(messages[2]?.content).not.toContain('sk-proj-aaa111');
    expect(messages[2]?.content).toContain('[REDACTED:openai_key]');
    expect(messages[2]?.reasoning_content).toContain('DATABASE_URL=[REDACTED:env_value]');
    expect(messages[2]?.reasoning_content).not.toContain('postgres://u:p@host/db');
    // tool_calls.function.arguments — wire shape preserved (still a JSON string), secret redacted
    const toolCalls = messages[2]?.tool_calls as Array<{
      function: { arguments: string };
    }>;
    expect(typeof toolCalls[0]?.function.arguments).toBe('string');
    expect(toolCalls[0]?.function.arguments).toContain('API_KEY=[REDACTED:env_value]');
    expect(toolCalls[0]?.function.arguments).not.toContain('topsecret123abc');
    // arguments is still parseable JSON (shape preservation)
    expect(() => JSON.parse(toolCalls[0]?.function.arguments ?? '')).not.toThrow();
    // tool result content redacted
    expect(messages[3]?.content).not.toContain('sk-proj-xyz789');
    expect(messages[3]?.content).toContain('[REDACTED:openai_key]');
  });
});
