// tests/unit/runtime/replSession.caveman.test.ts
//
// Phase 2.5 T36: unit tests for the /caveman slash command and the
// caveman prefix injection into the stream request.

import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { CAVEMAN_SYSTEM_PREFIX, type CavemanState } from '../../../src/runtime/cavemanMode.js';
import { runReplSession } from '../../../src/runtime/replSession.js';

// ─── Minimal recording client ────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(async () => {}),
  };
}

/**
 * Recording client: records every ChatRequest passed to stream(), yields a
 * single terminal turn (content_delta + done) per call.
 */
function recordingClient(): { client: DeepSeekClient; captured: ChatRequest[] } {
  const captured: ChatRequest[] = [];
  const client: DeepSeekClient = {
    id: 'v3' as const,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      captured.push(req);
      yield { type: 'content_delta', text: 'ok' };
      yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } };
    },
  };
  return { client, captured };
}

/** Minimal ToolRegistry stub that satisfies the shape used by runReplSession. */
// biome-ignore lint/suspicious/noExplicitAny: test mock
const stubTools: any = { definitions: () => [], invoke: vi.fn() };

// ─── /caveman slash command ───────────────────────────────────────────────────

describe('caveman slash command', () => {
  it('/caveman with no arg toggles active from false to true', async () => {
    const state: CavemanState = { active: false };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const toggleLog = infoCalls.find(
      (c: { event?: string }) => c.event === 'caveman_toggled' && c.source === 'slash',
    );
    expect(toggleLog).toBeDefined();
    expect(toggleLog.active).toBe(true);
    expect(slashOutputs).toHaveLength(1);
    expect(slashOutputs[0]).toBe('caveman ON');
  });

  it('/caveman with no arg toggles active from true to false', async () => {
    const state: CavemanState = { active: true };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(false);
    expect(slashOutputs[0]).toBe('caveman OFF');
  });

  it('/caveman on forces active true', async () => {
    const state: CavemanState = { active: false };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman on', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(true);
    expect(slashOutputs[0]).toBe('caveman ON');
  });

  it('/caveman off forces active false', async () => {
    const state: CavemanState = { active: true };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman off', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(false);
    expect(slashOutputs[0]).toBe('caveman OFF');
  });

  it('/caveman on when already active emits "(no change)" suffix', async () => {
    const state: CavemanState = { active: true };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman on', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(true);
    expect(slashOutputs[0]).toBe('caveman ON (no change)');
  });

  it('/caveman off when already inactive emits "(no change)" suffix', async () => {
    const state: CavemanState = { active: false };
    const logger = makeLogger();
    const slashOutputs: string[] = [];
    const { client } = recordingClient();

    const prompts = ['/caveman off', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: (t) => slashOutputs.push(t),
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    expect(state.active).toBe(false);
    expect(slashOutputs[0]).toBe('caveman OFF (no change)');
  });

  it('/caveman does not advance the engine (no stream call made)', async () => {
    const state: CavemanState = { active: false };
    const logger = makeLogger();
    const { client, captured } = recordingClient();

    const prompts = ['/caveman', '/quit'];
    let pi = 0;
    let turnCompleteCalls = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {
        turnCompleteCalls += 1;
      },
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    // No stream requests made, no turns completed.
    expect(captured).toHaveLength(0);
    expect(turnCompleteCalls).toBe(0);
  });
});

// ─── Caveman prefix injection into stream requests ────────────────────────────

describe('caveman prefix in stream requests', () => {
  it('next stream request includes the caveman prefix when state.active is true', async () => {
    const state: CavemanState = { active: true };
    const { client, captured } = recordingClient();

    const prompts = ['hello', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      cavemanState: state,
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req).toBeDefined();
    // The first message in the request must be the caveman system prefix.
    expect(req?.messages[0]).toEqual({ role: 'system', content: CAVEMAN_SYSTEM_PREFIX });
  });

  it('does NOT prepend the caveman prefix when state.active is false', async () => {
    const state: CavemanState = { active: false };
    const { client, captured } = recordingClient();

    const prompts = ['hello', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      cavemanState: state,
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req).toBeDefined();
    // First message must be the normal system prompt — NOT the caveman prefix.
    expect(req?.messages[0]?.content).not.toBe(CAVEMAN_SYSTEM_PREFIX);
  });

  it('prefix is applied after /caveman toggle — subsequent turn gets prefix', async () => {
    // Turn 1: /caveman (toggle on, no stream call)
    // Turn 2: "hello" — should now see the prefix in the request
    const state: CavemanState = { active: false };
    const logger = makeLogger();
    const { client, captured } = recordingClient();

    const prompts = ['/caveman', 'hello', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      onSlashOutput: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      logger: logger as any,
      cavemanState: state,
    });

    // After /caveman, state.active is true.
    expect(state.active).toBe(true);
    // One stream call (the "hello" turn).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messages[0]).toEqual({ role: 'system', content: CAVEMAN_SYSTEM_PREFIX });
  });

  it('does not apply prefix when cavemanState is not provided', async () => {
    // Omitting cavemanState entirely — the system prompt is the only system message.
    const { client, captured } = recordingClient();

    const prompts = ['hello', '/quit'];
    let pi = 0;
    await runReplSession({
      client: client as unknown as DeepSeekClient,
      tools: stubTools,
      model: 'mock',
      cwd: '/tmp',
      onState: () => {},
      onTurnComplete: () => {},
      readNextPrompt: async () => prompts[pi++] ?? '/quit',
      // cavemanState deliberately omitted
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    // First message is the default system prompt, not the caveman prefix.
    expect(req?.messages[0]?.content).not.toBe(CAVEMAN_SYSTEM_PREFIX);
    expect(req?.messages[0]?.role).toBe('system');
  });
});
