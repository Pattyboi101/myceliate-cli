// src/index.ts
import { loadDotenv } from './runtime/dotenv.js';
loadDotenv();

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { QueueEvents } from 'bullmq';
import { render } from 'ink';
import React from 'react';
import type { DeepSeekClient } from './adapters/DeepSeekClient.js';
import type { Message } from './adapters/messages.js';
import {
  type StreamEvent,
  isContentDelta,
  isError,
  isGermination,
  isReasoningDelta,
  isSystemMessage,
  isToolCall,
  isToolResult,
  isTurnComplete,
} from './adapters/streamEvent.js';
import { V3Adapter } from './adapters/v3/adapter.js';
import { V4Adapter } from './adapters/v4/adapter.js';
import { runMcpInstall } from './cli/mcpInstall.js';
import { parseSubcommand } from './cli/parseSubcommand.js';
import { ConversationLog } from './memory/conversationLog.js';
import { MarkdownStore } from './memory/markdownStore.js';
import type { QueryEngine } from './orchestrator/QueryEngine.js';
import { composeSystemSections } from './orchestrator/composeSystemSections.js';
import { buildSystemPrompt, senseContext } from './orchestrator/context.js';
import { getRedis } from './queue/connection.js';
import { bashQueue } from './queue/queues.js';
import { bootTools } from './runtime/bootTools.js';
import { defaultCavemanState } from './runtime/cavemanMode.js';
import { McpLifecycle } from './runtime/mcpLifecycle.js';
import { runReplSession } from './runtime/replSession.js';
import { buildTurnsFromHistory, isSafeToResume } from './runtime/resume.js';
import { checkAndWarnEnvOverride } from './runtime/roleToModel.js';
import { startWorker } from './runtime/workerLifecycle.js';
import { type ApprovalRequest, type ApprovalResponse, HitlGate } from './security/hitlGate.js';
import { bootSpores } from './spores/bootSpores.js';
import { App, type AppState, type CompletedTurn } from './ui/App.js';
import { runOnboarding } from './ui/onboarding.js';
import { createLogger } from './util/logger.js';

async function main(): Promise<void> {
  // Phase 2 boot reorder: senseContext + createLogger + checkAndWarnEnvOverride run BEFORE
  // runOnboarding so the env-override warn fires before Ink mounts (U4-safe: stderr only).
  const ctx = await senseContext({ cwd: process.cwd() });

  // Phase 3: unified argv parser — dispatches on subcommand kind.
  // Parses before heavy initialisation so mcp-install can run without
  // spinning up Redis, Ink, etc.
  const sub = parseSubcommand(process.argv.slice(2));
  if (sub.kind === 'mcp-install') {
    await runMcpInstall(sub);
    process.exit(0);
  }
  // sub.kind === 'interactive' — extract resumeId and noSpore.
  const resumeId = sub.resumeId;
  const noSpore = sub.noSpore;

  const sessionId = resumeId ?? randomUUID();
  const logger = createLogger({ logsDir: join(ctx.memoryDir, 'logs') });
  checkAndWarnEnvOverride(logger);

  // Phase 2.5: create mutable caveman state from env at boot.
  // The same object is passed by reference through to replSession → reactLoop →
  // QueryEngine.prepareRequest so a /caveman slash command's mutation takes
  // effect on the very next API request without restarting the session.
  const cavemanState = defaultCavemanState(process.env);
  logger.info({
    event: 'caveman_toggled',
    active: cavemanState.active,
    source: 'env-init',
  });

  const onboarding = await runOnboarding({
    ...(process.env.DEEPSEEK_API_KEY ? { apiKey: process.env.DEEPSEEK_API_KEY } : {}),
    ...(process.env.DEEPSEEK_ADAPTER === 'v3' || process.env.DEEPSEEK_ADAPTER === 'v4'
      ? { adapter: process.env.DEEPSEEK_ADAPTER }
      : {}),
  });
  const memory = new MarkdownStore(ctx.memoryDir);
  const conversation = new ConversationLog(memory, sessionId);

  // Phase 18: rehydrate prior session history if --resume was passed.
  // approvalResolvers and pendingApprovals intentionally start EMPTY — prior
  // session's Promise resolvers do not survive process exit (carry-forward #2).
  let initialHistory: readonly Message[] | undefined;
  let initialTurns: CompletedTurn[] = [];
  if (resumeId !== undefined) {
    const rehydrated = await ConversationLog.readSession(memory, resumeId);
    // Phase 18 review m5: refuse on missing-session ID instead of silently
    // starting a fresh log under the supplied (wrong) ID. `readSession`
    // returns [] for both "file not found" and "file exists but empty"; in
    // either case, an explicit --resume that finds nothing to resume is
    // user error and should fail loudly. v1.3 may add `myceliate sessions`
    // to list available IDs and a more granular distinction between
    // "missing" and "empty" via a tri-state return from readSession.
    if (rehydrated.length === 0) {
      console.error(
        `Cannot resume session ${resumeId}: no history found at .myceliate/history/${resumeId}.jsonl.\nUse \`ls .myceliate/history/\` to list available session IDs.`,
      );
      process.exit(1);
    }
    if (!isSafeToResume(rehydrated)) {
      console.error(
        `Cannot resume session ${resumeId}: last assistant turn has unanswered tool_calls.\nThe session was interrupted mid-flow. v1.2 refuses; v1.3 may add recovery.`,
      );
      process.exit(1);
    }
    initialHistory = rehydrated;
    // Rebuild AppState.turns from rehydrated history so the UI shows prior context.
    initialTurns = buildTurnsFromHistory(rehydrated);
  }

  // Phase 19: boot sector spores (unless --no-spore).
  const cwd = process.cwd();
  const spores = await bootSpores(cwd, noSpore, logger);
  let activeSpore = spores.activeSpore;
  let engineRef: QueryEngine | null = null;

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const client: DeepSeekClient =
    onboarding.adapter === 'v3'
      ? new V3Adapter({ apiKey: onboarding.apiKey, baseUrl })
      : new V4Adapter({ apiKey: onboarding.apiKey, baseUrl });

  // Phase 12.5: mount Ink straight into `awaiting_input` so the banner +
  // PromptInput render before the user submits anything. Removes the Clack
  // "What would you like the agent to do?" interrupt and gives the chat-like
  // start Patrick wanted.
  // Phase 18: on --resume, populate turns with prior context and drop straight
  // into `awaiting_input` with the rehydrated history visible.
  const activeName = spores.activeSpore;
  const activeSporeRecord = activeName ? spores.registry.get(activeName) : undefined;
  let uiActiveSpore: { name: string; accent_color: string } | null =
    activeName && activeSporeRecord
      ? { name: activeName, accent_color: activeSporeRecord.manifest.accent_color }
      : null;

  let state: AppState = {
    userInput: '',
    reasoning: null,
    content: '',
    approvalRequests: [],
    phase: 'awaiting_input',
    turns: initialTurns,
    toolCalls: [],
    activeSpore: uiActiveSpore,
    germinationCard: null,
    bootWarnings: [],
  };
  const banner = {
    // Banner display only — mirrors the env-override semantics in
    // src/runtime/roleToModel.ts (non-empty DEEPSEEK_MODEL bypasses routing).
    model:
      process.env.DEEPSEEK_MODEL && process.env.DEEPSEEK_MODEL.length > 0
        ? process.env.DEEPSEEK_MODEL
        : 'auto (Anamorph/Teleomorph)',
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
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'; // matches connection.ts:22 default
  const worker = await startWorker({
    redisUrl,
    logger,
    logsDir: join(ctx.memoryDir, 'logs'), // matches createLogger usage at index.ts:63
  });

  // Phase 3: construct McpLifecycle for MCP server process management.
  const mcpLifecycle = new McpLifecycle({
    logger,
    logsDir: join(ctx.memoryDir, 'logs'),
  });

  // Phase 23: bootTools extracts the tool registration block from index.ts and
  // adds setActiveSpore for allowlist management (Phase 23 Task 3).
  let bootWarnings: string[] = [];
  const { tools, setActiveSpore, teardownMcpSpore } = bootTools({
    hitl,
    queue,
    queueEvents,
    worker, // v1.5 Task 7: thread WorkerHandle for crash detection
    registry: spores.registry,
    cwd,
    logger,
    cavemanState,
    emit: (ev) => {
      if (isGermination(ev)) {
        uiActiveSpore = { name: ev.spore, accent_color: ev.accent_color };
        // Phase 21: set germinationCard so <GerminationCard> renders in-stream.
        rerender({ ...state, activeSpore: uiActiveSpore, germinationCard: uiActiveSpore });
        logger.info({ event: 'germination', spore: ev.spore });
      } else if (isSystemMessage(ev)) {
        // Phase 3: route MCP teardown / crash notifications into chat so the user
        // sees a line when their MCP server dies or is explicitly unpinned.
        const newTurn: CompletedTurn = { userInput: '', content: ev.text };
        rerender({ ...state, turns: [...state.turns, newTurn] });
      }
    },
    appendSystemPrompt: (section) => {
      // Phase 21 stretch: replaceGerminatedSection drops any prior germinated body
      // before pushing the new one, preventing double-sector-context stacking.
      engineRef?.replaceGerminatedSection(section);
    },
    activeSporeRef: () => activeSpore,
    setActiveSporeFromGerminate: (name) => {
      activeSpore = name;
      setActiveSpore(name);
    },
    // Phase 23 Case 8: surface stale-pin / allowlist-drift warnings as a
    // persistent yellow UI banner. Silent fail-open into a fully privileged
    // state defeats the user's expectation of a sandboxed orchestrator.
    onUserVisibleWarning: (msg) => {
      bootWarnings = [...bootWarnings, msg];
      rerender({ ...state, bootWarnings });
    },
    mcpLifecycle,
  });

  // Apply initial allowlist if a spore was already active at boot
  // (e.g., via prior pin file).
  if (spores.activeSpore) {
    setActiveSpore(spores.activeSpore);
  }

  // Per-turn streaming buffers (reset on each `turn_complete` and at the top of
  // every REPL iteration via the runReplSession `onState` callback below).
  let reasonStartedAt = Date.now();
  let reasoningText = '';
  let contentText = '';
  // Phase 12.5: every prompt now arrives via PromptInput, so there's no
  // pre-loop user message. lastSnapshotLen tracks the conv-log delta so
  // onTurnComplete only writes new messages to disk on each turn.
  // Phase 18: on --resume, start at the rehydrated history length so we do
  // NOT re-write the prior session's messages back to disk (they are already
  // in the .jsonl + .md). Without this, the first onTurnComplete call would
  // snapshot.slice(0) and re-append every rehydrated message, duplicating the log.
  let lastSnapshotLen = initialHistory?.length ?? 0;

  const descriptionsSection = composeSystemSections({
    registry: spores.registry,
    activeSpore: spores.activeSpore,
  });

  try {
    await runReplSession({
      client,
      tools,
      cwd: process.cwd(),
      systemPrompt: buildSystemPrompt(ctx) + spores.germinatedSection + descriptionsSection,
      workingBudget: Number(process.env.WORKING_TOKEN_BUDGET ?? 200_000),
      // exactOptionalPropertyTypes: conditional spread so the key is absent when not set.
      ...(initialHistory ? { initialHistory } : {}),
      onEngineReady: (engine) => {
        engineRef = engine;
      },
      sporeRegistry: spores.registry,
      logger,
      getActiveSpore: () => activeSpore,
      teardownMcpSpore,
      cavemanState,
      onSlashOutput: (text) => {
        // Phase 21: render slash command output as a completed turn (no streaming).
        const newTurn: CompletedTurn = { userInput: '', content: text };
        rerender({ ...state, turns: [...state.turns, newTurn] });
      },
      onActiveSporeChange: (name) => {
        // Phase 21: /spore pin or /spore unpin changed the active spore.
        // Phase 23: also update the registry allowlist via setActiveSpore.
        if (name === null) {
          uiActiveSpore = null;
          activeSpore = null;
          setActiveSpore(null);
        } else {
          const rec = spores.registry.get(name);
          if (rec) {
            uiActiveSpore = { name, accent_color: rec.manifest.accent_color };
            activeSpore = name;
          }
          setActiveSpore(name);
        }
        // Re-render the system-prompt section to advertise the new spore's commands.
        const newSection = composeSystemSections({ registry: spores.registry, activeSpore: name });
        engineRef?.replaceGerminatedSection(newSection);
        // Clear any visible germination card on slash-driven spore changes —
        // the card is for tool-call germination events; manual /spore pin/unpin
        // bypasses that path and shouldn't leave a stale card on screen.
        rerender({ ...state, activeSpore: uiActiveSpore, germinationCard: null });
      },
      onState: (ev: StreamEvent) => {
        if (isReasoningDelta(ev)) {
          reasoningText += ev.text;
          rerender({
            ...state,
            reasoning: { text: reasoningText, phase: 'streaming', startedAtMs: reasonStartedAt },
          });
        } else if (isContentDelta(ev)) {
          if (state.reasoning && state.reasoning.phase === 'streaming') {
            rerender({
              ...state,
              reasoning: { ...state.reasoning, phase: 'complete', endedAtMs: Date.now() },
            });
          }
          contentText += ev.text;
          rerender({ ...state, content: contentText });
        } else if (isToolCall(ev)) {
          logger.info({ event: 'tool_call', name: ev.name, id: ev.id });
          rerender({
            ...state,
            toolCalls: [
              ...state.toolCalls,
              { id: ev.id, name: ev.name, args: ev.args, status: 'running' },
            ],
          });
        } else if (isToolResult(ev)) {
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
        } else if (isTurnComplete(ev)) {
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
        } else if (isError(ev)) {
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
          activeSpore: uiActiveSpore,
          germinationCard: null,
          bootWarnings,
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
            activeSpore: uiActiveSpore,
            germinationCard: null,
            bootWarnings,
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
    await mcpLifecycle.teardownAll(); // Phase 3 (T29): allSettled semantics — individual MCP teardown failures do not abort worker.shutdown()
    await worker.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
