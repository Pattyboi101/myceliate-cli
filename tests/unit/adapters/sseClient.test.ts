import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../../src/transport/sseClient.js';

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield encoder.encode(p);
}

describe('parseSseStream', () => {
  it('emits one event per data: line, terminating on [DONE]', async () => {
    const stream = chunks(
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      'data: [DONE]\n\n',
    );
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('reassembles events split mid-chunk', async () => {
    const stream = chunks('data: {"a"', ':1}\n\nda', 'ta: {"a":2}\n\n', 'data: [DONE]\n\n');
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('ignores comment lines and empty data', async () => {
    const stream = chunks(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}']);
  });
});
