// tests/unit/runtime/replSession.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { runReplSession } from '../../../src/runtime/replSession.js';

function mockClient(scriptedTurns: StreamEvent[][]): {
  stream: (req: unknown) => AsyncIterable<StreamEvent>;
} {
  let i = 0;
  return {
    stream: async function* () {
      const events = scriptedTurns[i++] ?? [
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
      ];
      for (const ev of events) yield ev;
    },
  };
}

describe('runReplSession', () => {
  it('processes two prompts in sequence and persists the engine across both', async () => {
    const submitted: string[] = [];
    const turns: Message[][] = [];
    const client = mockClient([
      [
        { type: 'content_delta', text: 'first answer' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
      ],
      [
        { type: 'content_delta', text: 'second answer' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
      ],
    ]);
    const prompts = ['first', 'second', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as never,
      // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
      tools: { definitions: () => [], invoke: vi.fn() } as any,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: (snapshot) => turns.push([...snapshot]),
      readNextPrompt: async () => {
        const next = prompts[pi++] ?? '/quit';
        submitted.push(next);
        return next;
      },
    });
    expect(submitted).toEqual(['first', 'second', '/quit']);
    expect(turns.length).toBe(2);
    // Second turn's snapshot includes the first turn's user + assistant messages.
    expect(turns[1]?.length).toBeGreaterThan(turns[0]?.length ?? 0);
  });

  it('exits cleanly on /quit without running another turn', async () => {
    const client = mockClient([]);
    let calls = 0;
    await runReplSession({
      client: client as never,
      // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
      tools: { definitions: () => [], invoke: vi.fn() } as any,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {
        calls += 1;
      },
      readNextPrompt: async () => '/quit',
    });
    expect(calls).toBe(0);
  });
});
