import { describe, expect, it } from 'vitest';
import { SseConnectionError, parseSseStream } from '../../../src/transport/sseClient.js';

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield encoder.encode(p);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('parseSseStream', () => {
  it('emits one event per data: line, terminating on [DONE]', async () => {
    const events = await collect(
      parseSseStream(chunks('data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: [DONE]\n\n')),
    );
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('reassembles events split mid-chunk', async () => {
    const events = await collect(
      parseSseStream(chunks('data: {"a"', ':1}\n\nda', 'ta: {"a":2}\n\n', 'data: [DONE]\n\n')),
    );
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('ignores comment lines and empty data payloads', async () => {
    const events = await collect(
      parseSseStream(chunks(': keep-alive\n\ndata: \n\ndata: {"a":1}\n\ndata: [DONE]\n\n')),
    );
    expect(events).toEqual(['{"a":1}']);
  });

  it('handles CRLF separators per SSE spec (HTML §9.2)', async () => {
    const events = await collect(
      parseSseStream(chunks('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\ndata: [DONE]\r\n\r\n')),
    );
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('handles a CRLF split awkwardly across chunks (CR at end of one, LF at start of next)', async () => {
    const events = await collect(
      parseSseStream(chunks('data: {"a":1}\r', '\n\r\ndata: [DONE]\r\n\r\n')),
    );
    expect(events).toEqual(['{"a":1}']);
  });

  it('tolerates trailing whitespace on the [DONE] sentinel', async () => {
    const events = await collect(parseSseStream(chunks('data: {"a":1}\n\ndata: [DONE]  \n\n')));
    expect(events).toEqual(['{"a":1}']);
  });

  it('drains a final event when the stream closes without trailing blank line', async () => {
    const events = await collect(parseSseStream(chunks('data: {"a":1}')));
    expect(events).toEqual(['{"a":1}']);
  });
});

describe('SseConnectionError', () => {
  it('carries status, statusText, and body', () => {
    const err = new SseConnectionError(400, 'Bad Request', '{"error":{"message":"bad arg"}}');
    expect(err.status).toBe(400);
    expect(err.statusText).toBe('Bad Request');
    expect(err.body).toContain('bad arg');
    expect(err.message).toContain('400');
    expect(err.message).toContain('bad arg');
    expect(err.name).toBe('SseConnectionError');
    expect(err).toBeInstanceOf(Error);
  });
});
