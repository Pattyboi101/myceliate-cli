// tests/unit/orchestrator/reactLoop.test.ts
//
// F4: per-turn boundary semantics — runReactLoop yields a `turn_complete`
// event between iterations so consumers can reset per-turn UI state. Without
// this, multi-turn reasoning panels concatenated turn N's text onto turn N-1.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent, Usage } from '../../../src/adapters/streamEvent.js';
import { QueryEngine } from '../../../src/orchestrator/QueryEngine.js';
import { runReactLoop } from '../../../src/orchestrator/reactLoop.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

class ScriptedClient implements DeepSeekClient {
  readonly id = 'v3' as const;
  private callCount = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const events = this.turns[this.callCount] ?? [];
    this.callCount++;
    for (const e of events) yield e;
  }
}

function makeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'd',
    capability: 'execution',
    inputSchema: z.object({ msg: z.string() }),
    run: async ({ msg }) => msg,
  });
  return tools;
}

describe('runReactLoop turn-boundary semantics (F4)', () => {
  it('yields a turn_complete event between turns when a tool was called', async () => {
    const client = new ScriptedClient([
      [
        { type: 'reasoning_delta', text: 'A' },
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 'x' } },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'reasoning_delta', text: 'B' },
        { type: 'content_delta', text: 'answer' },
        { type: 'done', usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('go');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools: makeTools(), model: 'm' })) {
      events.push(ev);
    }
    // turn_complete should appear exactly once — between turn 1 (tool_call) and turn 2 (final answer).
    const boundaryIdx = events.findIndex((e) => e.type === 'turn_complete');
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1);
    // Order: reasoning_delta('A') → tool_call → turn_complete → reasoning_delta('B') → content_delta('answer')
    const types = events.map((e) => e.type);
    const aIdx = events.findIndex((e) => e.type === 'reasoning_delta' && e.text === 'A');
    const toolIdx = types.indexOf('tool_call');
    const bIdx = events.findIndex((e) => e.type === 'reasoning_delta' && e.text === 'B');
    const contentIdx = types.indexOf('content_delta');
    expect(aIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(boundaryIdx);
    expect(boundaryIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(contentIdx);
  });

  it('does NOT yield turn_complete on a single terminal turn (no tool calls)', async () => {
    const client = new ScriptedClient([
      [
        { type: 'reasoning_delta', text: 'thinking' },
        { type: 'content_delta', text: 'final answer' },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('go');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools: makeTools(), model: 'm' })) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
  });

  it('consumer can use turn_complete to reset per-turn buffers (smoke)', async () => {
    // Models the index.ts consumer: reset reasoning buffer on the boundary.
    // After consuming, turn 2's reasoning buffer is 'B', not 'AB'.
    const client = new ScriptedClient([
      [
        { type: 'reasoning_delta', text: 'A' },
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 'x' } },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'reasoning_delta', text: 'B' },
        { type: 'content_delta', text: 'answer' },
        { type: 'done', usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('go');
    let reasoningBuffer = '';
    let startedAt: number | null = null;
    let endedAt: number | null = null;
    let phase: 'streaming' | 'complete' = 'streaming';
    for await (const ev of runReactLoop({ client, engine, tools: makeTools(), model: 'm' })) {
      if (ev.type === 'reasoning_delta') {
        if (startedAt === null) startedAt = Date.now();
        reasoningBuffer += ev.text;
        phase = 'streaming';
      } else if (ev.type === 'content_delta' && phase === 'streaming') {
        endedAt = Date.now();
        phase = 'complete';
      } else if (ev.type === 'turn_complete') {
        // Reset per-turn state on the boundary.
        reasoningBuffer = '';
        startedAt = null;
        endedAt = null;
        phase = 'streaming';
      }
    }
    // Final state reflects ONLY turn 2's buffer.
    expect(reasoningBuffer).toBe('B');
    expect(startedAt).not.toBeNull();
    expect(endedAt).not.toBeNull();
    if (startedAt !== null && endedAt !== null) {
      // endedAtMs is set when the content phase begins, after reasoning streaming.
      expect(endedAt).toBeGreaterThanOrEqual(startedAt);
    }
  });
});

// Helpers for tool_result tests (adapted from existing ScriptedClient / makeTools above)
function makeMockClient(turns: StreamEvent[][]): DeepSeekClient {
  return new ScriptedClient(turns);
}

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
}

function makeMockTools(handlers: Record<string, () => Promise<string>>): ToolRegistry {
  const tools = new ToolRegistry();
  for (const [name, run] of Object.entries(handlers)) {
    tools.register({
      name,
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ command: z.string() }),
      run: async () => run(),
    });
  }
  return tools;
}

it('yields tool_result with status=completed and durationMs after a successful invoke', async () => {
  const tools = makeMockTools({
    bash: async () => 'OK',
  });
  const client = makeMockClient([
    [
      { type: 'tool_call', id: 't1', name: 'bash', args: { command: 'echo hi' } },
      { type: 'done', usage: zeroUsage() },
    ],
    [
      { type: 'content_delta', text: 'done' },
      { type: 'done', usage: zeroUsage() },
    ],
  ]);
  const events: StreamEvent[] = [];
  const engine = new QueryEngine({ systemPrompt: 's', workingBudget: 1_000_000 });
  engine.appendUser('go');
  for await (const ev of runReactLoop({ client, engine, tools, model: 'm', cwd: '/tmp' }))
    events.push(ev);
  const result = events.find(
    (e): e is Extract<StreamEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  expect(result).toBeDefined();
  expect(result?.status).toBe('completed');
  expect(result?.id).toBe('t1');
  expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  expect(result?.preview).toContain('OK');
});

it('locks event ordering: all tool_call → turn_complete → all tool_result (Phase 13 review M1 regression)', async () => {
  // Phase 13 review M1: the `src/index.ts` onState consumer relies on this
  // ordering. If turn_complete is repositioned (or if a future refactor drops
  // it before tool_call dispatch), the consumer's `tool_result` map will fire
  // against an empty `state.toolCalls` because turn_complete clears reasoning
  // state at that boundary. Locking the orchestrator-side ordering contract
  // here makes any drift fail loudly instead of silently breaking the cards.
  const tools = makeMockTools({ bash: async () => 'ok' });
  const client = makeMockClient([
    [
      { type: 'tool_call', id: 't1', name: 'bash', args: { command: 'a' } },
      { type: 'tool_call', id: 't2', name: 'bash', args: { command: 'b' } },
      { type: 'done', usage: zeroUsage() },
    ],
    [
      { type: 'content_delta', text: 'done' },
      { type: 'done', usage: zeroUsage() },
    ],
  ]);
  const events: StreamEvent[] = [];
  const engine = new QueryEngine({ systemPrompt: 's', workingBudget: 1_000_000 });
  engine.appendUser('go');
  for await (const ev of runReactLoop({ client, engine, tools, model: 'm', cwd: '/tmp' }))
    events.push(ev);
  const types = events.map((e) => e.type);
  const lastToolCall = types.lastIndexOf('tool_call');
  const turnComplete = types.indexOf('turn_complete');
  const firstToolResult = types.indexOf('tool_result');
  expect(lastToolCall).toBeGreaterThan(-1);
  expect(turnComplete).toBeGreaterThan(-1);
  expect(firstToolResult).toBeGreaterThan(-1);
  expect(lastToolCall).toBeLessThan(turnComplete);
  expect(turnComplete).toBeLessThan(firstToolResult);
});

it('yields tool_result with status=failed and a cause when invoke throws', async () => {
  const tools = makeMockTools({
    bash: async () => {
      throw new Error('spawn ENOENT');
    },
  });
  const client = makeMockClient([
    [
      { type: 'tool_call', id: 't2', name: 'bash', args: { command: 'doesntexist' } },
      { type: 'done', usage: zeroUsage() },
    ],
    [
      { type: 'content_delta', text: 'recovered' },
      { type: 'done', usage: zeroUsage() },
    ],
  ]);
  const events: StreamEvent[] = [];
  const engine = new QueryEngine({ systemPrompt: 's', workingBudget: 1_000_000 });
  engine.appendUser('go');
  for await (const ev of runReactLoop({ client, engine, tools, model: 'm', cwd: '/tmp' }))
    events.push(ev);
  const result = events.find(
    (e): e is Extract<StreamEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  expect(result).toBeDefined();
  expect(result?.status).toBe('failed');
  expect(result?.id).toBe('t2');
  expect(result?.cause).toBeInstanceOf(Error);
});

it('yields tool_result with status=rejected when invoke throws an HITL-rejected error', async () => {
  const tools = makeMockTools({
    bash: async () => {
      throw new Error('HITL rejected: user said no');
    },
  });
  const client = makeMockClient([
    [
      { type: 'tool_call', id: 'h1', name: 'bash', args: { command: 'rm -rf /' } },
      { type: 'done', usage: zeroUsage() },
    ],
    [
      { type: 'content_delta', text: 'recovered' },
      { type: 'done', usage: zeroUsage() },
    ],
  ]);
  const events: StreamEvent[] = [];
  const engine = new QueryEngine({ systemPrompt: 's', workingBudget: 1_000_000 });
  engine.appendUser('go');
  for await (const ev of runReactLoop({ client, engine, tools, model: 'm', cwd: '/tmp' }))
    events.push(ev);
  const result = events.find(
    (e): e is Extract<StreamEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  expect(result?.status).toBe('rejected');
});
