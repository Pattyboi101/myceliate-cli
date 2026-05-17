// tests/unit/spores/subagentLoop.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { CAVEMAN_SYSTEM_PREFIX } from '../../../src/runtime/cavemanMode.js';
import { type SubagentLoopResult, runSubagentLoop } from '../../../src/spores/subagentLoop.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function recordingClient(): { client: DeepSeekClient; captured: ChatRequest[] } {
  const captured: ChatRequest[] = [];
  const client: DeepSeekClient = {
    id: 'v3' as const,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      captured.push(req);
      // Single-turn conversational reply — no tool calls, terminate immediately.
      yield { type: 'content_delta', text: 'done' };
      yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } };
    },
  };
  return { client, captured };
}

// ─── Caveman prefix injection into subagent stream requests ──────────────────

describe('runSubagentLoop — caveman prefix', () => {
  it('prepends caveman prefix to messages when cavemanState.active is true', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const { client, captured } = recordingClient();
    await runSubagentLoop({
      client,
      personaSkill: 'You are a test sub-agent.',
      task: 'just say done',
      maxSteps: 1,
      cavemanState: { active: true },
    });
    expect(captured).toHaveLength(1);
    // messages[0] must be the caveman prefix system message.
    expect(captured[0]?.messages[0]).toEqual({ role: 'system', content: CAVEMAN_SYSTEM_PREFIX });
  });

  it('does NOT prepend caveman prefix when cavemanState.active is false', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const { client, captured } = recordingClient();
    await runSubagentLoop({
      client,
      personaSkill: 'You are a test sub-agent.',
      task: 'just say done',
      maxSteps: 1,
      cavemanState: { active: false },
    });
    expect(captured).toHaveLength(1);
    // First message is the persona skill system prompt, not the caveman prefix.
    expect(captured[0]?.messages[0]?.content).not.toBe(CAVEMAN_SYSTEM_PREFIX);
    expect(captured[0]?.messages[0]?.role).toBe('system');
    expect(captured[0]?.messages[0]?.content).toBe('You are a test sub-agent.');
  });
});

// ─── Model dispatch ───────────────────────────────────────────────────────────

describe('runSubagentLoop — Anamorph dispatch', () => {
  it('passes deepseek-v4-flash to client.stream by default', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const { client, captured } = recordingClient();
    await runSubagentLoop({
      client,
      personaSkill: 'You are a test sub-agent.',
      task: 'just say done',
      maxSteps: 1,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toBe('deepseek-v4-flash');
  });

  it('honours DEEPSEEK_MODEL env override', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', 'override-x');
    const { client, captured } = recordingClient();
    await runSubagentLoop({
      client,
      personaSkill: 'You are a test sub-agent.',
      task: 'just say done',
      maxSteps: 1,
    });
    expect(captured[0]?.model).toBe('override-x');
  });
});

// ─── Progress tracking ────────────────────────────────────────────────────────

describe('runSubagentLoop — progress tracking', () => {
  it('returns progress array with one entry per step', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    let call = 0;
    // Two-step client: step 0 emits a tool_call (forces another iteration);
    // step 1 emits only content + done (loop exits naturally).
    const twoStepClient: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
        if (call === 0) {
          call++;
          yield { type: 'tool_call', id: 'tc1', name: 'list_dir', args: { path: '.' } };
          yield {
            type: 'done',
            usage: { promptTokens: 5, completionTokens: 2, reasoningTokens: 0 },
          };
        } else {
          call++;
          yield { type: 'content_delta', text: 'final answer' };
          yield {
            type: 'done',
            usage: { promptTokens: 5, completionTokens: 4, reasoningTokens: 0 },
          };
        }
      },
    };
    const result: SubagentLoopResult = await runSubagentLoop({
      client: twoStepClient,
      personaSkill: 'You are a test sub-agent.',
      task: 'do two steps',
      maxSteps: 5,
    });
    expect(result.summary).toBe('final answer');
    expect(result.progress).toHaveLength(2);
    expect(result.progress[0]).toMatchObject({ step: 0, model: 'deepseek-v4-flash' });
    expect(result.progress[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.progress[1]).toMatchObject({ step: 1, model: 'deepseek-v4-flash' });
    expect(result.progress[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns progress with one entry for a single-step loop', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    const { client } = recordingClient();
    const result: SubagentLoopResult = await runSubagentLoop({
      client,
      personaSkill: 'You are a test sub-agent.',
      task: 'just say done',
      maxSteps: 1,
    });
    expect(result.progress).toHaveLength(1);
    expect(result.progress[0]).toMatchObject({ step: 0, model: 'deepseek-v4-flash' });
  });
});
