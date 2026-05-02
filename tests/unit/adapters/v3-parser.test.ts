import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { V3StreamState, parseV3Chunk } from '../../../src/adapters/v3/parser.js';

function collect(state: V3StreamState, jsonChunks: string[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const j of jsonChunks) for (const e of parseV3Chunk(state, j)) out.push(e);
  return out;
}

describe('parseV3Chunk', () => {
  it('emits reasoning_delta for reasoning_content fragments', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'I need ' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'to think' } }] }),
    ]);
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'I need ' },
      { type: 'reasoning_delta', text: 'to think' },
    ]);
  });

  it('emits content_delta for content fragments', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
    ]);
    expect(events).toEqual([
      { type: 'content_delta', text: 'Hello ' },
      { type: 'content_delta', text: 'world' },
    ]);
  });

  it('accumulates a tool_call across delta chunks and emits once on completion', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'read_file',
      args: { path: 'a.txt' },
    });
  });

  it('emits done with usage on the final chunk', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 2, reasoningTokens: 5 },
    });
  });

  it('emits done with zero-filled usage when upstream omits the usage block', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    });
  });

  it('drops empty content/reasoning deltas (stream punctuation, not user-visible)', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: '' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: '' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'real' } }] }),
    ]);
    expect(events).toEqual([{ type: 'content_delta', text: 'real' }]);
  });

  it('flushes pending tool_calls even when finish_reason is "stop" (upstream lenience)', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 't1', function: { name: 'ls', arguments: '{}' } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(events).toContainEqual({ type: 'tool_call', id: 't1', name: 'ls', args: {} });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('emits parallel tool calls keyed by distinct index', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
                { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toEqual([
      { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'a' } },
      { type: 'tool_call', id: 'b', name: 'read_file', args: { path: 'b' } },
    ]);
  });

  it('handles tool calls with empty arguments (zero-arg tools)', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'list_dir' } }] },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    expect(events).toContainEqual({ type: 'tool_call', id: 't', name: 'list_dir', args: {} });
  });
});
