// tests/unit/runtime/replSession.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { Message } from '../../../src/adapters/messages.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { runReplSession } from '../../../src/runtime/replSession.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { noopLogger } from '../../../src/util/noopLogger.js';

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

describe('replSession slash dispatcher routing', () => {
  async function buildFixtureRegistry(): Promise<{
    registry: SporeRegistry;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'myc-repl-disp-'));
    const packDir = join(root, 'research');
    await mkdir(join(packDir, 'commands'), { recursive: true });
    await writeFile(
      join(packDir, 'myceliate.yaml'),
      'name: research\ndescription: Research.\nversion: 1.0.0\naccent_color: "#4a90c4"\nagents: []',
      'utf8',
    );
    await writeFile(
      join(packDir, 'SKILL.md'),
      '---\nname: research\ndescription: Research.\n---\nbody',
      'utf8',
    );
    await writeFile(
      join(packDir, 'commands', 'lit-review.md'),
      '---\nname: lit-review\ndescription: Lit review.\nargument-hint: <topic>\n---\n\nProduce a lit review on: $ARGUMENTS',
      'utf8',
    );
    const registry = await SporeRegistry.discover(
      { bundledDir: root, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger: noopLogger },
    );
    return { registry, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it('expanded-prompt: dispatcher result body is appended to engine + react loop runs', async () => {
    const { registry, cleanup } = await buildFixtureRegistry();
    try {
      const slashOutputs: string[] = [];
      const completedTurnSnapshots: Message[][] = [];
      const client = mockClient([
        [
          { type: 'content_delta', text: 'lit review answer' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
        ],
      ]);
      const prompts = ['/research:lit-review graphene', '/quit'];
      let pi = 0;
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'research',
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: (snap) => completedTurnSnapshots.push([...snap]),
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });
      // The expanded body (not the raw slash input) should appear as the user message
      expect(completedTurnSnapshots.length).toBe(1);
      const userMsg = completedTurnSnapshots[0]?.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();
      if (userMsg && 'content' in userMsg && typeof userMsg.content === 'string') {
        expect(userMsg.content).toContain('Produce a lit review on: graphene');
        expect(userMsg.content).not.toContain('/research:lit-review');
      }
      // No orchestrator-output was emitted
      expect(slashOutputs).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('orchestrator-output: dispatcher message routes through onSlashOutput', async () => {
    const { registry, cleanup } = await buildFixtureRegistry();
    try {
      const slashOutputs: string[] = [];
      const client = mockClient([]);
      const prompts = ['/research:nonexistent-cmd', '/quit'];
      let pi = 0;
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'research',
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });
      // The failure message routes via onSlashOutput; engine is NOT advanced
      expect(slashOutputs.some((s) => s.includes('has no command'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // Phase 24 Task 4: closes test gap D from Phase 21. Coverage-fill on slash
  // routing edge cases. Phase 22 Task 7 wired the routing; these assert the
  // routing's behavioural contract under three boundary conditions.

  it('expanded-prompt body that is itself a slash-looking string is NOT re-dispatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myc-repl-norecurse-'));
    try {
      const packDir = join(root, 'research');
      await mkdir(join(packDir, 'commands'), { recursive: true });
      await writeFile(
        join(packDir, 'myceliate.yaml'),
        'name: research\ndescription: Research.\nversion: 1.0.0\naccent_color: "#4a90c4"\nagents: []',
        'utf8',
      );
      await writeFile(
        join(packDir, 'SKILL.md'),
        '---\nname: research\ndescription: Research.\n---\nbody',
        'utf8',
      );
      // Body itself starts with what LOOKS like a namespaced slash command —
      // when expanded, it must NOT be re-dispatched. The whole expanded body
      // (including the leading `/research:other-cmd`) is fed verbatim to the
      // engine as the user message.
      await writeFile(
        join(packDir, 'commands', 'echo-slash.md'),
        '---\nname: echo-slash\ndescription: Echo.\n---\n\n/research:other-cmd $ARGUMENTS',
        'utf8',
      );
      const registry = await SporeRegistry.discover(
        { bundledDir: root, userDir: '/nonexistent', projectDir: '/nonexistent' },
        { logger: noopLogger },
      );

      const completedTurnSnapshots: Message[][] = [];
      // Note: only ONE scripted turn — if dispatcher recursed, runReactLoop
      // would be invoked twice and the second call would fall off the
      // scripted-turns array (returning the empty default), but engine
      // would have appended TWO user messages. The assertion below catches
      // that by counting user-role messages in the final snapshot.
      const client = mockClient([
        [
          { type: 'content_delta', text: 'reply' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
        ],
      ]);
      const prompts = ['/research:echo-slash xyz', '/quit'];
      let pi = 0;
      const slashOutputs: string[] = [];
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'research',
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: (snap) => completedTurnSnapshots.push([...snap]),
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });

      // Exactly one turn completed (no recursive dispatch).
      expect(completedTurnSnapshots.length).toBe(1);
      // Exactly one user message in the snapshot — the expanded body, not two.
      const userMsgs = completedTurnSnapshots[0]?.filter((m) => m.role === 'user') ?? [];
      expect(userMsgs).toHaveLength(1);
      const userMsg = userMsgs[0];
      expect(userMsg).toBeDefined();
      if (userMsg && 'content' in userMsg && typeof userMsg.content === 'string') {
        // Body is appended verbatim — including the leading "/research:other-cmd"
        // (it was NOT stripped or re-dispatched).
        expect(userMsg.content).toContain('/research:other-cmd xyz');
      }
      // No orchestrator-output side-channel was emitted (no error message
      // about a missing "other-cmd" command, which would have appeared if
      // the body had been re-dispatched).
      expect(slashOutputs).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orchestrator-output for an inactive spore does NOT advance the engine', async () => {
    const { registry, cleanup } = await buildFixtureRegistry();
    try {
      const slashOutputs: string[] = [];
      const completedTurnSnapshots: Message[][] = [];
      // No turns scripted — if the engine were advanced, runReactLoop would
      // attempt to read a turn and the test scaffolding would still go
      // through, so we ALSO assert turnComplete callback count is 0.
      const client = mockClient([]);
      const prompts = ['/research:lit-review topic', '/quit'];
      let pi = 0;
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        sporeRegistry: registry,
        // Crucially: no spore is active.
        getActiveSpore: () => null,
        logger: noopLogger,
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: (snap) => completedTurnSnapshots.push([...snap]),
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });
      // Dispatcher returned orchestrator-output: the user got a guidance
      // message, the engine was NOT advanced.
      expect(slashOutputs.some((s) => s.includes('requires the "research" spore'))).toBe(true);
      expect(completedTurnSnapshots).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('no-match: prompt starting with /spore falls through to the inline /spore block', async () => {
    const { registry, cleanup } = await buildFixtureRegistry();
    try {
      const slashOutputs: string[] = [];
      const client = mockClient([]);
      const prompts = ['/spore list', '/quit'];
      let pi = 0;
      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd: '/tmp',
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => null,
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });
      // /spore list output contains 'research' (the fixture pack) — proves
      // handleSporeList ran (i.e. fell through to the inline /spore block).
      expect(slashOutputs.some((s) => s.includes('research'))).toBe(true);
      // The dispatcher branch of routing must NOT have produced any of its
      // characteristic error messages — those would appear if "/spore list"
      // had been mistakenly parsed as a namespaced /<pack>:<command>.
      expect(slashOutputs.some((s) => s.includes('no spore named'))).toBe(false);
      expect(slashOutputs.some((s) => s.includes('has no command'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// ─── T29: teardownMcpSpore wiring in /spore unpin ────────────────────────────

describe('replSession /spore unpin teardownMcpSpore wiring', () => {
  /**
   * Build a minimal fixture registry with one regular spore (no mcp_server)
   * and one MCP spore (with mcp_server).
   */
  async function buildPinFixtureRegistry(): Promise<{
    registry: SporeRegistry;
    cwd: string;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'myc-repl-unpin-'));
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });

    // Plain spore — no mcp_server
    const plainDir = join(root, 'plain-spore');
    await mkdir(plainDir, { recursive: true });
    await writeFile(
      join(plainDir, 'myceliate.yaml'),
      'name: plain-spore\ndescription: Plain.\nversion: 1.0.0\naccent_color: "#aabbcc"\nagents: []',
      'utf8',
    );
    await writeFile(
      join(plainDir, 'SKILL.md'),
      '---\nname: plain-spore\ndescription: Plain spore.\n---\nbody',
      'utf8',
    );

    // MCP spore — has mcp_server
    const mcpDir = join(root, 'mcp-spore');
    await mkdir(mcpDir, { recursive: true });
    await writeFile(
      join(mcpDir, 'myceliate.yaml'),
      'name: mcp-spore\ndescription: MCP.\nversion: 1.0.0\naccent_color: "#112233"\nagents: []\nmcp_server:\n  command: node\n  args: [server.js]\n',
      'utf8',
    );
    await writeFile(
      join(mcpDir, 'SKILL.md'),
      '---\nname: mcp-spore\ndescription: MCP spore.\n---\nbody',
      'utf8',
    );

    const registry = await SporeRegistry.discover(
      { bundledDir: root, userDir: '/nonexistent', projectDir: '/nonexistent' },
      { logger: noopLogger },
    );

    return {
      registry,
      cwd,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it('/spore unpin invokes teardownMcpSpore with the previously-pinned spore name', async () => {
    const { registry, cwd, cleanup } = await buildPinFixtureRegistry();
    try {
      // First pin plain-spore so unpin has something to act on.
      const { writePin, clearPin: _clearPin } = await import('../../../src/spores/pinFile.js');
      await writePin(cwd, 'plain-spore', noopLogger);

      const teardownCalls: string[] = [];
      const teardownMcpSpore = vi.fn(async (name: string) => {
        teardownCalls.push(name);
      });

      const client = mockClient([]);
      const prompts = ['/spore unpin', '/quit'];
      let pi = 0;

      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd,
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'plain-spore',
        teardownMcpSpore,
        onState: () => {},
        onSlashOutput: () => {},
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });

      expect(teardownMcpSpore).toHaveBeenCalledOnce();
      expect(teardownCalls).toEqual(['plain-spore']);
    } finally {
      await cleanup();
    }
  });

  it('/spore unpin does NOT invoke teardownMcpSpore when no spore is active', async () => {
    const { registry, cwd, cleanup } = await buildPinFixtureRegistry();
    try {
      const teardownMcpSpore = vi.fn(async (_name: string) => {});

      const client = mockClient([]);
      const prompts = ['/spore unpin', '/quit'];
      let pi = 0;

      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd,
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => null,
        teardownMcpSpore,
        onState: () => {},
        onSlashOutput: () => {},
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });

      expect(teardownMcpSpore).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('/spore pin to another spore does NOT invoke teardownMcpSpore (multi-active model)', async () => {
    const { registry, cwd, cleanup } = await buildPinFixtureRegistry();
    try {
      const teardownMcpSpore = vi.fn(async (_name: string) => {});

      const client = mockClient([]);
      const prompts = ['/spore pin plain-spore', '/quit'];
      let pi = 0;

      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd,
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'mcp-spore',
        teardownMcpSpore,
        onState: () => {},
        onSlashOutput: () => {},
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });

      expect(teardownMcpSpore).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('/spore unpin still clears the pin file (regression — existing behavior unchanged)', async () => {
    const { registry, cwd, cleanup } = await buildPinFixtureRegistry();
    try {
      const { writePin } = await import('../../../src/spores/pinFile.js');
      const { readPin } = await import('../../../src/spores/pinFile.js');
      await writePin(cwd, 'plain-spore', noopLogger);

      const teardownMcpSpore = vi.fn(async (_name: string) => {});
      const slashOutputs: string[] = [];

      const client = mockClient([]);
      const prompts = ['/spore unpin', '/quit'];
      let pi = 0;

      await runReplSession({
        client: client as unknown as DeepSeekClient,
        // biome-ignore lint/suspicious/noExplicitAny: mock collaborator
        tools: { definitions: () => [], invoke: vi.fn() } as any,
        model: 'mock',
        cwd,
        sporeRegistry: registry,
        logger: noopLogger,
        getActiveSpore: () => 'plain-spore',
        teardownMcpSpore,
        onState: () => {},
        onSlashOutput: (t) => slashOutputs.push(t),
        onTurnComplete: () => {},
        readNextPrompt: async () => prompts[pi++] ?? '/quit',
      });

      // Pin file was cleared
      const pinAfter = await readPin(cwd, noopLogger);
      expect(pinAfter).toBeNull();
      // Unpin message was emitted
      expect(slashOutputs.some((s) => s.toLowerCase().includes('unpin'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
