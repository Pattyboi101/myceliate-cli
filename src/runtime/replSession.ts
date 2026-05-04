// src/runtime/replSession.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { Message } from '../adapters/messages.js';
import type { StreamEvent } from '../adapters/streamEvent.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { runReactLoop } from '../orchestrator/reactLoop.js';
import type { ToolRegistry } from '../tools/registry.js';

export type ReplSessionOptions = {
  client: DeepSeekClient;
  tools: ToolRegistry;
  model: string;
  cwd: string;
  systemPrompt?: string;
  workingBudget?: number;
  /** Phase 18: pre-rehydrated initial history for --resume <id>. */
  initialHistory?: readonly Message[];
  /** Streamed events from each turn — consumer wires this to App state. */
  onState: (ev: StreamEvent) => void;
  /** Fires once after each terminal turn with the engine snapshot. */
  onTurnComplete: (history: readonly Message[]) => void | Promise<void>;
  /** Resolves with the next user prompt (or "/quit" / empty to exit). */
  readNextPrompt: () => Promise<string>;
};

// Phase 12 review m2 fix: `''` removed from QUIT_TOKENS so an accidental empty
// Enter re-prompts instead of silently exiting. Ctrl+D in PromptInput sends
// `/quit` explicitly for shell-EOF parity.
const QUIT_TOKENS = new Set(['/quit', '/exit']);

export async function runReplSession(opts: ReplSessionOptions): Promise<void> {
  const engine = new QueryEngine({
    systemPrompt: opts.systemPrompt ?? 'You are myceliate, an autonomous CLI agent.',
    workingBudget: opts.workingBudget ?? 200_000,
    // exactOptionalPropertyTypes: conditional spread so the key is absent when not provided.
    ...(opts.initialHistory ? { initialHistory: opts.initialHistory } : {}),
  });

  while (true) {
    const prompt = (await opts.readNextPrompt()).trim();
    if (QUIT_TOKENS.has(prompt)) return;
    if (prompt.length === 0) continue; // Empty submit just re-prompts.

    engine.appendUser(prompt);
    for await (const ev of runReactLoop({
      client: opts.client,
      engine,
      tools: opts.tools,
      model: opts.model,
      cwd: opts.cwd,
    })) {
      opts.onState(ev);
    }
    await opts.onTurnComplete(engine.snapshot());
  }
}
