// tests/unit/orchestrator/reactLoop.cost.test.ts
//
// Phase 2.5: verifies that runReactLoop emits a `cost_estimated` log entry
// and fires the `onCostEstimate` callback per iteration when the `done` event
// carries non-zero usage stats.
import { describe, expect, it, vi } from 'vitest';
import type { DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { QueryEngine } from '../../../src/orchestrator/QueryEngine.js';
import { runReactLoop } from '../../../src/orchestrator/reactLoop.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

/**
 * Build a fake DeepSeekClient that yields a scripted sequence of events per
 * stream() call. Each element of `events` is one full turn's event list.
 * Mirrors the ScriptedClient pattern from reactLoop.test.ts.
 */
function recordingClient(events: StreamEvent[][]): DeepSeekClient {
  let call = 0;
  return {
    id: 'v3' as const,
    async *stream() {
      const turn = events[call++] ?? [];
      for (const ev of turn) yield ev;
    },
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(async () => {}),
  };
}

describe('reactLoop cost_estimated emission', () => {
  it('logs cost_estimated per iter when done.usage has non-zero tokens', async () => {
    const logger = makeLogger();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'hello' },
      {
        type: 'done',
        usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 0 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('hi');
    const tools = new ToolRegistry();

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    for await (const _ev of runReactLoop({ client, engine, tools, logger: logger as any })) {
      // drain
    }

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const costEvent = infoCalls.find((c: { event?: string }) => c.event === 'cost_estimated');
    expect(costEvent).toBeDefined();
    expect(costEvent.inputTokens).toBe(100);
    expect(costEvent.outputTokens).toBe(50);
    expect(costEvent.cachedInputTokens).toBe(0);
    expect(costEvent.totalCost).toBeGreaterThan(0);
    // iter 0 dispatches repl-with-reasoning (planning bias) => deepseek-v4-pro
    expect(costEvent.role).toBe('repl-with-reasoning');
    expect(costEvent.iter).toBe(0);
    expect(costEvent.model).toBe('deepseek-v4-pro');
  });

  it('includes cachedInputTokens in log when cacheHitTokens is present', async () => {
    const logger = makeLogger();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'hi' },
      {
        type: 'done',
        usage: { promptTokens: 200, completionTokens: 80, reasoningTokens: 0, cacheHitTokens: 40 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('hi');
    const tools = new ToolRegistry();

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    for await (const _ev of runReactLoop({ client, engine, tools, logger: logger as any })) {
      // drain
    }

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const costEvent = infoCalls.find((c: { event?: string }) => c.event === 'cost_estimated');
    expect(costEvent).toBeDefined();
    expect(costEvent.cachedInputTokens).toBe(40);
    // Cache hit cost should be non-zero since cacheHitTokens > 0
    expect(costEvent.cacheHitCost).toBeGreaterThan(0);
  });

  it('fires onCostEstimate callback with breakdown', async () => {
    const onCostEstimate = vi.fn();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'hi' },
      {
        type: 'done',
        usage: { promptTokens: 200, completionTokens: 100, reasoningTokens: 0 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('hi');
    const tools = new ToolRegistry();

    for await (const _ev of runReactLoop({ client, engine, tools, onCostEstimate })) {
      // drain
    }

    expect(onCostEstimate).toHaveBeenCalledTimes(1);
    const breakdown = onCostEstimate.mock.calls[0]?.[0];
    expect(breakdown).toBeDefined();
    expect(breakdown.totalCost).toBeGreaterThan(0);
    // iter 0 with no DEEPSEEK_MODEL env => default Pro model
    expect(breakdown.model).toBe('deepseek-v4-pro');
    expect(typeof breakdown.inputCost).toBe('number');
    expect(typeof breakdown.outputCost).toBe('number');
    expect(typeof breakdown.cacheHitCost).toBe('number');
  });

  it('does NOT emit cost_estimated when done has zero tokens (upstream zero-fill)', async () => {
    const logger = makeLogger();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'hi' },
      {
        type: 'done',
        // zero-filled — simulates an upstream that omits usage on error cutoff
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('hi');
    const tools = new ToolRegistry();

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    for await (const _ev of runReactLoop({ client, engine, tools, logger: logger as any })) {
      // drain
    }

    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    expect(infoCalls.find((c: { event?: string }) => c.event === 'cost_estimated')).toBeUndefined();
  });

  it('does NOT fire onCostEstimate when done has zero tokens', async () => {
    const onCostEstimate = vi.fn();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'hi' },
      {
        type: 'done',
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('hi');
    const tools = new ToolRegistry();

    for await (const _ev of runReactLoop({ client, engine, tools, onCostEstimate })) {
      // drain
    }

    expect(onCostEstimate).not.toHaveBeenCalled();
  });

  it('emits cost_unknown_model warn and cost_estimated when model is not in PRICING', async () => {
    const logger = makeLogger();
    const events: StreamEvent[] = [
      { type: 'content_delta', text: 'result' },
      {
        type: 'done',
        usage: { promptTokens: 50, completionTokens: 20, reasoningTokens: 0 },
      },
    ];
    const client = recordingClient([events]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('go');
    const tools = new ToolRegistry();

    // Force an unknown model via the model override (env-override pattern).
    for await (const _ev of runReactLoop({
      client,
      engine,
      tools,
      model: 'ollama:llama3',
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
    })) {
      // drain
    }

    // cost_estimated still emitted (with zero totalCost for unknown model)
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const costEvent = infoCalls.find((c: { event?: string }) => c.event === 'cost_estimated');
    expect(costEvent).toBeDefined();
    expect(costEvent.model).toBe('ollama:llama3');
    expect(costEvent.totalCost).toBe(0);

    // cost_unknown_model warn emitted
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const warnCalls = (logger.warn as any).mock.calls.map((c: any[]) => c[0]);
    const warnEvent = warnCalls.find((c: { event?: string }) => c.event === 'cost_unknown_model');
    expect(warnEvent).toBeDefined();
    expect(warnEvent.model).toBe('ollama:llama3');
  });

  it('emits cost_estimated once per iteration in a multi-turn loop', async () => {
    const onCostEstimate = vi.fn();
    const logger = makeLogger();

    // Two turns: first has a tool call (to force a second iteration), second is terminal.
    const clientEvents: StreamEvent[][] = [
      [
        // Turn 1: tool call — forces a second iteration
        { type: 'content_delta', text: 'calling tool' },
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 'x' } },
        {
          type: 'done',
          usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 0 },
        },
      ],
      [
        // Turn 2: terminal answer
        { type: 'content_delta', text: 'done' },
        {
          type: 'done',
          usage: { promptTokens: 150, completionTokens: 30, reasoningTokens: 0 },
        },
      ],
    ];

    // Register a minimal 'echo' tool so tool invocation succeeds
    const { z } = await import('zod');
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'echo',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({ msg: z.string() }) },
      run: async ({ msg }: { msg: string }) => msg,
    });

    const client = recordingClient(clientEvents);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    engine.appendUser('go');

    for await (const _ev of runReactLoop({
      client,
      engine,
      tools,
      onCostEstimate,
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
    })) {
      // drain
    }

    // One cost_estimated per iteration
    expect(onCostEstimate).toHaveBeenCalledTimes(2);
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const costEvents = infoCalls.filter((c: { event?: string }) => c.event === 'cost_estimated');
    expect(costEvents).toHaveLength(2);
    // iter field should be 0 and 1
    expect(costEvents[0].iter).toBe(0);
    expect(costEvents[1].iter).toBe(1);
  });
});
