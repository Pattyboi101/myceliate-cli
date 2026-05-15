// tests/unit/spores/subagentLoop.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { CAVEMAN_SYSTEM_PREFIX } from '../../../src/runtime/cavemanMode.js';
import { runSubagentLoop } from '../../../src/spores/subagentLoop.js';

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
