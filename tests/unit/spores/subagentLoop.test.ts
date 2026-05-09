// tests/unit/spores/subagentLoop.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
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
