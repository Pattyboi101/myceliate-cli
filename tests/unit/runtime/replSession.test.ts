// tests/unit/runtime/replSession.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
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
      client: client as unknown as DeepSeekClient,
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

  // Phase 12 review M1 regression test: integration of replSession +
  // ConversationLog must not duplicate turn 1 in the on-disk history when a
  // second turn fires. The previous fromIndex heuristic in src/index.ts wrote
  // the entire snapshot on turn 2, drag-writing turn 1 again.
  it('writes each engine message to ConversationLog exactly once across multiple turns', async () => {
    const { ConversationLog } = await import('../../../src/memory/conversationLog.js');
    const { MarkdownStore } = await import('../../../src/memory/markdownStore.js');
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = await mkdtemp(join(tmpdir(), 'myc-repl-multi-'));
    try {
      const store = new MarkdownStore(tmp);
      const log = new ConversationLog(store, 'sess-multi');

      const client = mockClient([
        [
          { type: 'content_delta', text: 'A1' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
        ],
        [
          { type: 'content_delta', text: 'A2' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
        ],
      ]);
      const prompts = ['Q1', 'Q2', '/quit'];
      let pi = 0;
      let lastSnapshotLen = 1;
      let firstPromptConsumed = false;
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        onState: () => {},
        onTurnComplete: async (snapshot) => {
          for (const m of snapshot.slice(lastSnapshotLen)) await log.appendTurn(m);
          lastSnapshotLen = snapshot.length;
        },
        readNextPrompt: async () => {
          const next = prompts[pi++] ?? '/quit';
          if (!firstPromptConsumed) {
            firstPromptConsumed = true;
            // Eager initial-prompt write mirrors src/index.ts crash-safety path.
            await log.appendTurn({ role: 'user', content: next });
          }
          return next;
        },
      });

      const onDisk = await readFile(join(tmp, 'history', 'sess-multi.md'), 'utf8');
      const q1Count = (onDisk.match(/^### user\n\nQ1$/gm) ?? []).length;
      const q2Count = (onDisk.match(/^### user\n\nQ2$/gm) ?? []).length;
      const a1Count = (onDisk.match(/^### assistant\n\nA1/gm) ?? []).length;
      const a2Count = (onDisk.match(/^### assistant\n\nA2/gm) ?? []).length;
      expect(q1Count).toBe(1);
      expect(q2Count).toBe(1);
      expect(a1Count).toBe(1);
      expect(a2Count).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('exits cleanly on /quit without running another turn', async () => {
    const client = mockClient([]);
    let calls = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
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
