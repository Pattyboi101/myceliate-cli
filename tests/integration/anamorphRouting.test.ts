// tests/integration/anamorphRouting.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatRequest, DeepSeekClient } from '../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../src/adapters/streamEvent.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';
import { runReactLoop } from '../../src/orchestrator/reactLoop.js';
import { runSubagentLoop } from '../../src/spores/subagentLoop.js';
import { ToolRegistry } from '../../src/tools/registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('anamorph routing — plumbing reaches the wire', () => {
  it('subagentLoop dispatches deepseek-v4-flash', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const captured: ChatRequest[] = [];
    const client: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(req): AsyncIterable<StreamEvent> {
        captured.push(req);
        yield { type: 'content_delta', text: 'ack' };
        yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } };
      },
    };
    await runSubagentLoop({
      client,
      personaSkill: 'test sub-agent',
      task: 'noop',
      maxSteps: 1,
    });
    expect(captured.at(0)?.model).toBe('deepseek-v4-flash');
  });

  it('reactLoop iteration 0 dispatches deepseek-v4-pro (planning bias)', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const captured: ChatRequest[] = [];
    const client: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(req): AsyncIterable<StreamEvent> {
        captured.push(req);
        yield { type: 'content_delta', text: 'ack' };
        yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } };
      },
    };
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 200_000 });
    engine.appendUser('what is 2+2');
    const tools = new ToolRegistry();
    for await (const _ev of runReactLoop({ client, engine, tools, maxIterations: 1 })) {
      // drain
    }
    expect(captured.at(0)?.model).toBe('deepseek-v4-pro');
  });

  it('reactLoop demotes to flash on iteration 1 when iter 0 produced no retained reasoning', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    let call = 0;
    const captured: ChatRequest[] = [];
    const client: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(req): AsyncIterable<StreamEvent> {
        captured.push(req);
        call += 1;
        if (call === 1) {
          // Iter 0: produce a tool call WITHOUT reasoning_content. Reasoning ratchet
          // should NOT engage (hasRetainedReasoning checks for tool_calls AND reasoning).
          yield { type: 'tool_call', id: 't1', name: 'noop', args: {} };
          yield {
            type: 'done',
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
          };
        } else {
          yield { type: 'content_delta', text: 'done' };
          yield {
            type: 'done',
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
          };
        }
      },
    };
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 200_000 });
    engine.appendUser('run noop');
    const tools = new ToolRegistry();
    tools.register({
      name: 'noop',
      description: 'no-op tool for testing',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({}) },
      run: async () => 'noop done',
    });
    for await (const _ev of runReactLoop({ client, engine, tools, maxIterations: 2 })) {
      // drain
    }
    expect(captured.at(0)?.model).toBe('deepseek-v4-pro'); // iter 0 — planning bias
    expect(captured.at(1)?.model).toBe('deepseek-v4-flash'); // iter 1 — demoted
  });

  it('reactLoop ratchets to Pro after retained reasoning', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    let call = 0;
    const captured: ChatRequest[] = [];
    const client: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(req): AsyncIterable<StreamEvent> {
        captured.push(req);
        call += 1;
        if (call === 1) {
          yield { type: 'reasoning_delta', text: 'thinking deeply' };
          yield { type: 'tool_call', id: 't1', name: 'noop', args: {} };
          yield {
            type: 'done',
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
          };
        } else {
          yield { type: 'content_delta', text: 'done' };
          yield {
            type: 'done',
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
          };
        }
      },
    };
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 200_000 });
    engine.appendUser('think hard then run noop');
    const tools = new ToolRegistry();
    tools.register({
      name: 'noop',
      description: 'no-op tool for testing',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: z.object({}) },
      run: async () => 'noop done',
    });
    for await (const _ev of runReactLoop({ client, engine, tools, maxIterations: 2 })) {
      // drain
    }
    expect(captured.at(0)?.model).toBe('deepseek-v4-pro'); // iter 0 — planning bias
    expect(captured.at(1)?.model).toBe('deepseek-v4-pro'); // iter 1 — ratchet
  });
});
