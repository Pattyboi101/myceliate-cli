// src/index.ts
import { loadDotenv } from './runtime/dotenv.js';
loadDotenv();

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { QueueEvents } from 'bullmq';
import { render } from 'ink';
import React from 'react';
import type { DeepSeekClient } from './adapters/DeepSeekClient.js';
import type { StreamEvent } from './adapters/streamEvent.js';
import { V3Adapter } from './adapters/v3/adapter.js';
import { V4Adapter } from './adapters/v4/adapter.js';
import { ConversationLog } from './memory/conversationLog.js';
import { MarkdownStore } from './memory/markdownStore.js';
import { buildSystemPrompt, senseContext } from './orchestrator/context.js';
import { getRedis } from './queue/connection.js';
import { bashQueue } from './queue/queues.js';
import { runReplSession } from './runtime/replSession.js';
import { startWorker } from './runtime/workerLifecycle.js';
import { type ApprovalRequest, type ApprovalResponse, HitlGate } from './security/hitlGate.js';
import { createBashTool } from './tools/bash.js';
import { grepTool } from './tools/grep.js';
import { listDirTool } from './tools/listDir.js';
import { readFileTool } from './tools/readFile.js';
import { ToolRegistry } from './tools/registry.js';
import { writeFileTool } from './tools/writeFile.js';
import { App, type AppState, type CompletedTurn } from './ui/App.js';
import { runOnboarding } from './ui/onboarding.js';
import { createLogger } from './util/logger.js';

async function main(): Promise<void> {
  const onboarding = await runOnboarding({
    ...(process.env.DEEPSEEK_API_KEY ? { apiKey: process.env.DEEPSEEK_API_KEY } : {}),
    ...(process.env.DEEPSEEK_ADAPTER === 'v3' || process.env.DEEPSEEK_ADAPTER === 'v4'
      ? { adapter: process.env.DEEPSEEK_ADAPTER }
      : {}),
    ...(process.env.DEEPSEEK_MODEL ? { model: process.env.DEEPSEEK_MODEL } : {}),
  });

  const ctx = await senseContext({ cwd: process.cwd() });
  const sessionId = randomUUID();
  const logger = createLogger({ logsDir: join(ctx.memoryDir, 'logs') });
  const memory = new MarkdownStore(ctx.memoryDir);
  const conversation = new ConversationLog(memory, sessionId);

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const client: DeepSeekClient =
    onboarding.adapter === 'v3'
      ? new V3Adapter({ apiKey: onboarding.apiKey, baseUrl })
      : new V4Adapter({ apiKey: onboarding.apiKey, baseUrl });

  const tools = new ToolRegistry();

  // Phase 12.5: mount Ink straight into `awaiting_input` so the banner +
  // PromptInput render before the user submits anything. Removes the Clack
  // "What would you like the agent to do?" interrupt and gives the chat-like
  // start Patrick wanted.
  let state: AppState = {
    userInput: '',
    reasoning: null,
    content: '',
    approvalRequests: [],
    phase: 'awaiting_input',
    turns: [],
    toolCalls: [],
  };
  const banner = {
    model: onboarding.model,
    adapter: onboarding.adapter,
    cwd: process.cwd(),
  };
  let promptResolver: ((value: string) => void) | null = null;
  const onPromptSubmit = (text: string): void => {
    if (promptResolver) {
      const r = promptResolver;
      promptResolver = null;
      r(text);
    }
  };

  // HITL UI bridge — Map<requestId, fn> pattern (Phase 17 m5 fix).
  // Replaces the single-slot approvalResolver; concurrent HITL requests are
  // keyed by their originating tool_call.id so neither orphans the other.
  const approvalResolvers = new Map<string, (r: ApprovalResponse) => void>();
  let pendingApprovals: ApprovalRequest[] = [];

  const ink = render(React.createElement(App, { state, banner, onPromptSubmit }));
  const rerender = (next: AppState): void => {
    state = next;
    ink.rerender(React.createElement(App, { state, banner, onPromptSubmit, onApprovalResponse }));
  };

  // onApprovalResponse must be defined after rerender (which it references).
  // It is forward-referenced safely in the render/rerender calls above because
  // the function is only called at runtime when the user responds to an approval prompt.
  // noUncheckedIndexedAccess: pendingApprovals[0] returns ApprovalRequest | undefined.
  // Use destructure-with-guard per Phase 15 review n3.
  const onApprovalResponse = (response: ApprovalResponse): void => {
    const head = pendingApprovals[0];
    if (!head) return;
    const fn = approvalResolvers.get(head.requestId);
    if (!fn) return;
    pendingApprovals = pendingApprovals.slice(1);
    approvalResolvers.delete(head.requestId);
    fn(response);
    rerender({ ...state, approvalRequests: pendingApprovals });
  };

  // Re-render with onApprovalResponse now that it is defined.
  ink.rerender(React.createElement(App, { state, banner, onPromptSubmit, onApprovalResponse }));

  const hitl = new HitlGate({
    requestApproval: (req: ApprovalRequest) =>
      new Promise<ApprovalResponse>((resolve) => {
        approvalResolvers.set(req.requestId, resolve);
        pendingApprovals = [...pendingApprovals, req];
        rerender({ ...state, approvalRequests: pendingApprovals });
      }),
  });

  const queue = bashQueue();
  const queueEvents = new QueueEvents('bash', { connection: getRedis() });
  const worker = startWorker();

  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(grepTool);
  tools.register(createBashTool({ hitl, queue, queueEvents, defaultTimeoutMs: 30_000 }));

  // Per-turn streaming buffers (reset on each `turn_complete` and at the top of
  // every REPL iteration via the runReplSession `onState` callback below).
  let reasonStartedAt = Date.now();
  let reasoningText = '';
  let contentText = '';
  // Phase 12.5: every prompt now arrives via PromptInput, so there's no
  // pre-loop user message. lastSnapshotLen starts at 0 and tracks the conv-log
  // delta from there.
  let lastSnapshotLen = 0;

  try {
    await runReplSession({
      client,
      tools,
      model: onboarding.model,
      cwd: process.cwd(),
      systemPrompt: buildSystemPrompt(ctx),
      workingBudget: Number(process.env.WORKING_TOKEN_BUDGET ?? 200_000),
      onState: (ev: StreamEvent) => {
        if (ev.type === 'reasoning_delta') {
          reasoningText += ev.text;
          rerender({
            ...state,
            reasoning: { text: reasoningText, phase: 'streaming', startedAtMs: reasonStartedAt },
          });
        } else if (ev.type === 'content_delta') {
          if (state.reasoning && state.reasoning.phase === 'streaming') {
            rerender({
              ...state,
              reasoning: { ...state.reasoning, phase: 'complete', endedAtMs: Date.now() },
            });
          }
          contentText += ev.text;
          rerender({ ...state, content: contentText });
        } else if (ev.type === 'tool_call') {
          logger.info({ event: 'tool_call', name: ev.name, id: ev.id });
          rerender({
            ...state,
            toolCalls: [
              ...state.toolCalls,
              { id: ev.id, name: ev.name, args: ev.args, status: 'running' },
            ],
          });
        } else if (ev.type === 'tool_result') {
          logger.info({
            event: 'tool_result',
            id: ev.id,
            status: ev.status,
            durationMs: ev.durationMs,
          });
          rerender({
            ...state,
            toolCalls: state.toolCalls.map((c) =>
              c.id === ev.id
                ? {
                    ...c,
                    status: ev.status,
                    durationMs: ev.durationMs,
                    ...(ev.preview ? { preview: ev.preview } : {}),
                    ...(ev.cause
                      ? { error: ev.cause instanceof Error ? ev.cause.message : String(ev.cause) }
                      : {}),
                  }
                : c,
            ),
          });
        } else if (ev.type === 'turn_complete') {
          // F4 reset: clear per-turn reasoning + content buffers so turn N's
          // content does not concatenate onto turn N-1's. Phase 13 review M1:
          // do NOT clear `toolCalls` here. `runReactLoop` yields `turn_complete`
          // BEFORE the `for (const call of pendingCalls)` loop (reactLoop.ts:82),
          // which means `tool_result` events arrive AFTER `turn_complete`. If we
          // wiped `toolCalls` on `turn_complete`, the subsequent `tool_result`
          // map would silently no-op against an empty array and cards would
          // never transition from `running` to `completed`/`failed`. Cards are
          // cleared at the REPL boundary instead — `onTurnComplete` and the
          // `readNextPrompt` resolver below.
          //
          // Phase 17 review m4: `approvalRequests` shares the same invariant
          // and is intentionally NOT cleared on `turn_complete`. A HITL gate
          // can fire mid-turn (the bash tool calls `checkBash` from inside
          // tool execution); when `turn_complete` yields, an approval prompt
          // may still be visible and unresolved. Clearing `approvalRequests`
          // here would orphan the resolver in `approvalResolvers` (Map keyed
          // by requestId — the entry survives, but no UI exposes it). The
          // queue is correctly drained at REPL boundaries: `onTurnComplete`
          // (after all tool_results have arrived) and `readNextPrompt` (when
          // the user submits the next prompt).
          reasoningText = '';
          contentText = '';
          reasonStartedAt = Date.now();
          rerender({ ...state, reasoning: null, content: '' });
        } else if (ev.type === 'error') {
          logger.error({
            event: 'stream_error',
            message: ev.cause instanceof Error ? ev.cause.message : String(ev.cause),
          });
        }
      },
      onTurnComplete: async (snapshot) => {
        // Phase 12 review M1 fix: append only the delta since the last flush.
        // Previous heuristic (state.turns.length === 0 && firstPromptConsumed
        // ? 1 : 0) re-wrote turn 1 on every subsequent turn, duplicating
        // history entries. Tracking lastSnapshotLen instead is unconditional
        // and correct across any turn count.
        for (const m of snapshot.slice(lastSnapshotLen)) await conversation.appendTurn(m);
        lastSnapshotLen = snapshot.length;
        const newTurn: CompletedTurn = { userInput: state.userInput, content: contentText };
        const turns = [...state.turns, newTurn];
        // Reset live region; show prompt input for next turn.
        reasoningText = '';
        contentText = '';
        rerender({
          userInput: '',
          reasoning: null,
          content: '',
          approvalRequests: [],
          phase: 'awaiting_input',
          turns,
          toolCalls: [],
        });
      },
      readNextPrompt: async () =>
        new Promise<string>((resolve) => {
          promptResolver = resolve;
        }).then((text) => {
          rerender({
            userInput: text,
            reasoning: null,
            content: '',
            approvalRequests: [],
            phase: 'streaming',
            turns: state.turns,
            toolCalls: [],
          });
          return text;
        }),
    });
  } finally {
    // Phase 17 review m5 — known leak: if `pendingApprovals` has unresolved
    // entries when we reach this finally (e.g., user `/quit`s with an HITL
    // prompt visible), the corresponding resolvers in `approvalResolvers`
    // never fire. The bash subprocess waiting on the orphaned promise is
    // unblocked by the parent process exit anyway (worker.shutdown below
    // SIGTERMs the worker, killing the subprocess), so this is not a
    // data-integrity issue — but a v1.3 cleanup could iterate the Map and
    // reject each pending resolver with an explicit `aborted-on-shutdown`
    // error so the bash tool path surfaces cleanly instead of relying on
    // process exit to free the held promise.
    await logger.flush();
    ink.unmount();
    await queueEvents.close();
    await queue.close();
    await worker.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
