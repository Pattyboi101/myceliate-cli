// src/index.ts
import { loadDotenv } from './runtime/dotenv.js';
loadDotenv();

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { render } from 'ink';
import React from 'react';
import type { DeepSeekClient } from './adapters/DeepSeekClient.js';
import type { StreamEvent } from './adapters/streamEvent.js';
import { V3Adapter } from './adapters/v3/adapter.js';
import { V4Adapter } from './adapters/v4/adapter.js';
import { ConversationLog } from './memory/conversationLog.js';
import { MarkdownStore } from './memory/markdownStore.js';
import { buildSystemPrompt, senseContext } from './orchestrator/context.js';
import { runReplSession } from './runtime/replSession.js';
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
  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(grepTool);

  // Phase 12.5: mount Ink straight into `awaiting_input` so the banner +
  // PromptInput render before the user submits anything. Removes the Clack
  // "What would you like the agent to do?" interrupt and gives the chat-like
  // start Patrick wanted.
  let state: AppState = {
    userInput: '',
    reasoning: null,
    content: '',
    approvalRequest: null,
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
  const ink = render(React.createElement(App, { state, banner, onPromptSubmit }));
  const rerender = (next: AppState): void => {
    state = next;
    ink.rerender(React.createElement(App, { state, banner, onPromptSubmit }));
  };

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
          // F4 reset, extended: clear per-turn buffers AND toolCalls so each turn's
          // card list shows only the current turn's calls (not a growing stack across
          // a multi-turn ReAct flow).
          reasoningText = '';
          contentText = '';
          reasonStartedAt = Date.now();
          rerender({ ...state, reasoning: null, content: '', toolCalls: [] });
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
          approvalRequest: null,
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
            approvalRequest: null,
            phase: 'streaming',
            turns: state.turns,
            toolCalls: [],
          });
          return text;
        }),
    });
  } finally {
    await logger.flush();
    ink.unmount();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
