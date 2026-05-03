// tests/integration/reactLoop.test.ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DeepSeekClient } from '../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../src/adapters/streamEvent.js';
import { MarkdownStore } from '../../src/memory/markdownStore.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';
import { runReactLoop } from '../../src/orchestrator/reactLoop.js';
import { ToolRegistry } from '../../src/tools/registry.js';

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

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-react-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runReactLoop (mock client)', () => {
  it('handles a single tool-call → tool-result → final-answer flow', async () => {
    const client = new ScriptedClient([
      [
        { type: 'reasoning_delta', text: 'I will echo' },
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 'hi' } },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 5, reasoningTokens: 3 } },
      ],
      [
        { type: 'content_delta', text: 'Done.' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    engine.appendUser('say hi');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(true);
    expect(events.some((e) => e.type === 'content_delta' && e.text === 'Done.')).toBe(true);
    const snap = engine.snapshot();
    expect(snap.find((m) => m.role === 'tool')).toMatchObject({
      result: { content: 'hi', tool_use_id: 't1' },
    });
  });

  it('maxIterations exhaustion yields a final error StreamEvent', async () => {
    // Every turn returns tool_calls so the loop never terminates naturally
    const client = new ScriptedClient(
      Array.from({ length: 30 }, () => [
        { type: 'tool_call' as const, id: 't1', name: 'echo', args: { msg: 'loop' } },
        {
          type: 'done' as const,
          usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 },
        },
      ]),
    );
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 100_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    engine.appendUser('loop forever');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm', maxIterations: 3 }))
      events.push(ev);
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.cause).toBeInstanceOf(Error);
      if (last.cause instanceof Error) {
        expect(last.cause.message).toContain('maxIterations=3');
      }
    }
  });

  it('tool invocation that throws results in is_error:true tool result (not a thrown exception)', async () => {
    const client = new ScriptedClient([
      [
        { type: 'tool_call', id: 'tx', name: 'boom', args: {} },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'recovered' },
        { type: 'done', usage: { promptTokens: 2, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'boom',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({}),
      run: async () => {
        throw new Error('kaboom');
      },
    });
    engine.appendUser('blow up');
    // The loop should NOT throw — it should swallow the error and inject an error tool result
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);
      })(),
    ).resolves.toBeUndefined();
    const snap = engine.snapshot();
    const toolResult = snap.find((m) => m.role === 'tool');
    if (toolResult?.role !== 'tool') throw new Error('no tool result');
    expect(toolResult.result.is_error).toBe(true);
    expect(toolResult.result.content).toContain('kaboom');
  });

  it('oversized tool result is offloaded to artifact and pointer is injected (directive #4)', async () => {
    const artifactRoot = join(tmp, '.myceliate');
    await mkdir(artifactRoot, { recursive: true });
    const artifactStore = new MarkdownStore(artifactRoot);
    const bigContent = 'x'.repeat(5_000);

    const client = new ScriptedClient([
      [
        { type: 'tool_call', id: 'ta', name: 'bigout', args: {} },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'got artifact' },
        { type: 'done', usage: { promptTokens: 2, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'bigout',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({}),
      run: async () => bigContent,
    });
    engine.appendUser('get big output');

    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({
      client,
      engine,
      tools,
      model: 'm',
      artifactStore,
      artifactThresholdBytes: 1_000,
    }))
      events.push(ev);

    const snap = engine.snapshot();
    const toolResult = snap.find((m) => m.role === 'tool');
    if (toolResult?.role !== 'tool') throw new Error('no tool result');

    // The stored content should be a pointer summary, not the raw big content
    const content = toolResult.result.content;
    expect(content).toMatch(/\[artifact:[0-9a-f]{16}\]/);
    expect(content).toContain('bytes stored at');
    expect(content).toContain('preview:');
    expect(content).not.toBe(bigContent);

    // The artifact file should exist on disk
    const idMatch = content.match(/\[artifact:([0-9a-f]{16})\]/);
    expect(idMatch).not.toBeNull();
    if (!idMatch) throw new Error('no id match');
    const artifactPath = join(artifactRoot, `artifacts/${idMatch[1]}.md`);
    const { access } = await import('node:fs/promises');
    await expect(access(artifactPath)).resolves.toBeUndefined();
  });

  it('terminal assistant message is appended before early return on no-tool-call turn', async () => {
    const client = new ScriptedClient([
      [
        { type: 'content_delta', text: 'final answer' },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 3, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    engine.appendUser('simple question');

    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);

    const snap = engine.snapshot();
    const asst = snap.find((m) => m.role === 'assistant');
    expect(asst).not.toBeUndefined();
    if (asst?.role !== 'assistant') throw new Error('no assistant');
    expect(asst.content).toBe('final answer');
  });

  it('cwd is threaded to tool context', async () => {
    let observedCwd: string | undefined;
    const client = new ScriptedClient([
      [
        { type: 'tool_call', id: 'tc', name: 'cwd_spy', args: {} },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'done' },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'cwd_spy',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({}),
      run: async (_input, ctx) => {
        observedCwd = ctx.cwd;
        return 'ok';
      },
    });
    engine.appendUser('check cwd');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm', cwd: tmp }))
      events.push(ev);
    expect(observedCwd).toBe(tmp);
  });

  it('ZodError from mistyped tool args becomes is_error: true (loop continues)', async () => {
    // Tool schema rejects bad input → registry.invoke throws ZodError → reactLoop's
    // try/catch wraps into an is_error result. Loop must NOT propagate the throw;
    // the agent recovers and the next turn happens normally.
    const client = new ScriptedClient([
      [
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 123 } }, // wrong type — string expected
        { type: 'done', usage: { promptTokens: 5, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'Recovered.' },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    engine.appendUser('say hi');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);
    const tool = engine.snapshot().find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
    if (tool?.role === 'tool') {
      expect(tool.result.is_error).toBe(true);
      expect(tool.result.content.length).toBeGreaterThan(0);
    }
    // Loop continued — second turn's content_delta arrived
    expect(events.some((e) => e.type === 'content_delta' && e.text === 'Recovered.')).toBe(true);
  });

  it('non-async tool run() that throws synchronously is caught and recovered', async () => {
    // The registry's `invoke` is `async` — that's the load-bearing safety net that
    // converts a synchronous throw inside any non-async run() into a rejected
    // Promise, which the reactLoop's try/catch then handles uniformly. Without it,
    // a single sync throw would crash the generator and the whole agent.
    const client = new ScriptedClient([
      [
        { type: 'tool_call', id: 't1', name: 'boom', args: {} },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 1, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'Recovered.' },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'boom',
      description: 'd',
      capability: 'execution',
      inputSchema: z.object({}),
      // Non-async run that throws synchronously. Return type is `never`,
      // assignable to `Promise<string>` because `never` is the bottom type.
      run: () => {
        throw new Error('sync boom');
      },
    });
    engine.appendUser('test');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);
    const tool = engine.snapshot().find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
    if (tool?.role === 'tool') {
      expect(tool.result.is_error).toBe(true);
      expect(tool.result.content).toContain('sync boom');
    }
    expect(events.some((e) => e.type === 'content_delta' && e.text === 'Recovered.')).toBe(true);
  });
});
