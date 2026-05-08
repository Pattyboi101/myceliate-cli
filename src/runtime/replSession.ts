// src/runtime/replSession.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { Message } from '../adapters/messages.js';
import type { StreamEvent } from '../adapters/streamEvent.js';
import { handleSporeList, handleSporePin, handleSporeUnpin } from '../cli/sporeSlashCommands.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { runReactLoop } from '../orchestrator/reactLoop.js';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
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
  /** Fires once after the QueryEngine is constructed. Use to register dynamic system-prompt mutators. */
  onEngineReady?: (engine: QueryEngine) => void;
  /**
   * Phase 21: spore registry for /spore slash command handling.
   * Optional — if absent, /spore commands are passed to the model as text.
   */
  sporeRegistry?: SporeRegistry;
  /**
   * Phase 21: fires when a slash command produces output (e.g. /spore list).
   * Consumer renders it to the UI. Omitting falls back to console.log.
   */
  onSlashOutput?: (text: string) => void;
  /**
   * Phase 21: fires when /spore pin or /spore unpin changes the active spore.
   * Consumer re-renders the InputBox border colour.
   */
  onActiveSporeChange?: (name: string | null) => void;
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
  opts.onEngineReady?.(engine);

  const emitSlash = opts.onSlashOutput ?? ((t) => console.log(t));

  while (true) {
    const prompt = (await opts.readNextPrompt()).trim();
    if (QUIT_TOKENS.has(prompt)) return;
    if (prompt.length === 0) continue; // Empty submit just re-prompts.

    // Phase 21: /spore command interception — handled locally, not sent to model.
    if (opts.sporeRegistry && prompt.startsWith('/spore')) {
      const parts = prompt.slice(6).trim().split(/\s+/);
      const sub = parts[0] ?? '';
      if (sub === 'list' || sub === '') {
        emitSlash(await handleSporeList({ registry: opts.sporeRegistry }));
        continue;
      }
      if (sub === 'pin') {
        const name = parts[1] ?? '';
        if (!name) {
          emitSlash('Usage: /spore pin <name>');
          continue;
        }
        const result = await handleSporePin({ registry: opts.sporeRegistry, cwd: opts.cwd, name });
        emitSlash(result.message);
        if (result.ok) opts.onActiveSporeChange?.(name);
        continue;
      }
      if (sub === 'unpin') {
        const result = await handleSporeUnpin({ cwd: opts.cwd });
        emitSlash(result.message);
        if (result.ok) opts.onActiveSporeChange?.(null);
        continue;
      }
      emitSlash(
        `Unknown /spore subcommand: ${sub}. Try: /spore list | /spore pin <name> | /spore unpin`,
      );
      continue;
    }

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
