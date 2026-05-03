import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// src/index.ts
import { render } from 'ink';
import React from 'react';
import type { DeepSeekClient } from './adapters/DeepSeekClient.js';
import { V3Adapter } from './adapters/v3/adapter.js';
import { V4Adapter } from './adapters/v4/adapter.js';
import { ConversationLog } from './memory/conversationLog.js';
import { MarkdownStore } from './memory/markdownStore.js';
import { QueryEngine } from './orchestrator/QueryEngine.js';
import { senseContext } from './orchestrator/context.js';
import { runReactLoop } from './orchestrator/reactLoop.js';
import { grepTool } from './tools/grep.js';
import { listDirTool } from './tools/listDir.js';
import { readFileTool } from './tools/readFile.js';
import { ToolRegistry } from './tools/registry.js';
import { writeFileTool } from './tools/writeFile.js';
import { App, type AppState } from './ui/App.js';
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

  const engine = new QueryEngine({
    systemPrompt: ctx.claudeMd || 'You are myceliate, an autonomous CLI agent.',
    workingBudget: Number(process.env.WORKING_TOKEN_BUDGET ?? 200_000),
  });
  engine.appendUser(onboarding.initialPrompt);
  await conversation.appendTurn({ role: 'user', content: onboarding.initialPrompt });

  let state: AppState = {
    userInput: onboarding.initialPrompt,
    reasoning: null,
    content: '',
    approvalRequest: null,
  };
  const ink = render(React.createElement(App, { state }));

  const reasonStartedAt = Date.now();
  let reasoningText = '';
  let contentText = '';

  for await (const ev of runReactLoop({
    client,
    engine,
    tools,
    model: onboarding.model,
    cwd: process.cwd(), // FIX #2: thread cwd explicitly to runReactLoop, even though it defaults to process.cwd() internally — entry point is the top-level configuration manifest, explicit DI is clearer to readers
  })) {
    if (ev.type === 'reasoning_delta') {
      reasoningText += ev.text;
      state = {
        ...state,
        reasoning: { text: reasoningText, phase: 'streaming', startedAtMs: reasonStartedAt },
      };
    } else if (ev.type === 'content_delta') {
      if (state.reasoning && state.reasoning.phase === 'streaming') {
        state = { ...state, reasoning: { ...state.reasoning, phase: 'complete' } };
      }
      contentText += ev.text;
      state = { ...state, content: contentText };
    } else if (ev.type === 'tool_call') {
      logger.info({ event: 'tool_call', name: ev.name, id: ev.id });
    } else if (ev.type === 'error') {
      // FIX #1: ev.cause is typed `unknown` in streamEvent.ts:13 — must narrow before reading .message, otherwise won't typecheck under strict mode.
      logger.error({
        event: 'stream_error',
        message: ev.cause instanceof Error ? ev.cause.message : String(ev.cause),
      });
    }
    ink.rerender(React.createElement(App, { state }));
  }

  // FIX #3: snapshot().slice(1) skips the initial user turn that was already written via appendTurn above.
  // This preserves crash-safety: if the ReAct loop crashes mid-stream, the user prompt is still on disk.
  // The tradeoff (slightly uglier slice) is accepted because Markdown files are the definitive source of truth.
  for (const m of engine.snapshot().slice(1)) await conversation.appendTurn(m);
  await logger.flush();
  ink.unmount();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
