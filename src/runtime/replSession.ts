// src/runtime/replSession.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { Message } from '../adapters/messages.js';
import type { StreamEvent } from '../adapters/streamEvent.js';
import { dispatch } from '../cli/slashDispatcher.js';
import {
  handleSporeList,
  handleSporePin,
  handleSporeTools,
  handleSporeUnpin,
} from '../cli/sporeSlashCommands.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { runReactLoop } from '../orchestrator/reactLoop.js';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger } from '../util/logger.js';
import type { CavemanState } from './cavemanMode.js';

export type ReplSessionOptions = {
  client: DeepSeekClient;
  tools: ToolRegistry;
  /** Optional explicit override; when unset, runReactLoop's role-based dispatch fires. */
  model?: string;
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
   * Consumer renders it to the UI. Omitting silently drops the output —
   * NEVER falls back to console.log because U4 forbids stdout writes while
   * Ink is mounted (ANSI corruption). Production callers always provide it.
   */
  onSlashOutput?: (text: string) => void;
  /**
   * Phase 21: fires when /spore pin or /spore unpin changes the active spore.
   * Consumer re-renders the InputBox border colour.
   */
  onActiveSporeChange?: (name: string | null) => void;
  /**
   * Phase 22: structured logger for slash audit + future telemetry.
   * Required when sporeRegistry is provided for pack-command dispatch.
   */
  logger?: Logger;
  /**
   * Phase 22: returns the currently active spore name (null if none). Read fresh per dispatch
   * because /spore pin/unpin can change it between turns.
   */
  getActiveSpore?: () => string | null;
  /**
   * Phase 3 (T29): closure returned by bootTools() that tears down a single
   * MCP-spore's server and tool wrappers.  Invoked on `/spore unpin` so that
   * MCP servers do not outlive the pin that caused their germination.
   *
   * Safe to call for non-MCP spores (deregisters 0 wrappers, teardown is a
   * no-op for unknown spores in McpLifecycle).  Optional — when absent, unpin
   * proceeds without teardown (backwards-compatible with pre-Phase-3 callers).
   */
  teardownMcpSpore?: (sporeName: string) => Promise<void>;
  /**
   * Phase 2.5: mutable caveman state created at boot from MYCELIATE_CAVEMAN env.
   * Passed by reference so the `/caveman` slash handler can mutate state.active
   * directly and the next prepareRequest call reads the updated value.
   * Optional — when absent, caveman mode is never applied (inactive by default).
   */
  cavemanState?: CavemanState;
};

// Phase 12 review m2 fix: `''` removed from QUIT_TOKENS so an accidental empty
// Enter re-prompts instead of silently exiting. Ctrl+D in PromptInput sends
// `/quit` explicitly for shell-EOF parity.
const QUIT_TOKENS = new Set(['/quit', '/exit']);

export async function runReplSession(opts: ReplSessionOptions): Promise<void> {
  // Phase 22 review fix: the JSDoc on `logger` says it is required when
  // `sporeRegistry` is provided, but the type is `?:`. This runtime check
  // makes the contract explicit so a future caller that omits `logger` while
  // wiring a registry fails fast instead of silently dropping pack-command
  // dispatch (which would let `/<pack>:<command>` input fall through to the
  // model as raw text — a quiet correctness regression).
  if (opts.sporeRegistry !== undefined && opts.logger === undefined) {
    throw new Error(
      'replSession: sporeRegistry requires logger (slash dispatcher cannot run without audit logging)',
    );
  }
  const engine = new QueryEngine({
    systemPrompt: opts.systemPrompt ?? 'You are myceliate, an autonomous CLI agent.',
    workingBudget: opts.workingBudget ?? 200_000,
    // exactOptionalPropertyTypes: conditional spread so the key is absent when not provided.
    ...(opts.initialHistory ? { initialHistory: opts.initialHistory } : {}),
  });
  opts.onEngineReady?.(engine);

  // Silent no-op fallback — see ReplSessionOptions.onSlashOutput JSDoc for
  // the U4 reasoning. Production paths always provide a real handler.
  const emitSlash = opts.onSlashOutput ?? ((_t: string) => {});

  while (true) {
    const prompt = (await opts.readNextPrompt()).trim();
    if (QUIT_TOKENS.has(prompt)) return;
    if (prompt.length === 0) continue; // Empty submit just re-prompts.

    // Phase 2.5: /caveman slash command — toggle / force on / force off.
    // Handled BEFORE the namespaced dispatcher so it works regardless of whether
    // a sporeRegistry is configured (and because it is a simple state mutation,
    // not a registry lookup).
    if (prompt === '/caveman' || prompt.startsWith('/caveman ')) {
      if (opts.cavemanState !== undefined && opts.logger !== undefined) {
        const arg = prompt.slice('/caveman'.length).trim();
        const prevActive = opts.cavemanState.active;
        if (arg === 'on') {
          opts.cavemanState.active = true;
        } else if (arg === 'off') {
          opts.cavemanState.active = false;
        } else {
          // No arg (or unrecognised arg) → toggle.
          opts.cavemanState.active = !opts.cavemanState.active;
        }
        opts.logger.info({
          event: 'caveman_toggled',
          active: opts.cavemanState.active,
          source: 'slash',
        });
        const status = opts.cavemanState.active ? 'caveman ON' : 'caveman OFF';
        const noChange = opts.cavemanState.active === prevActive;
        emitSlash(noChange ? `${status} (no change)` : status);
      } else {
        // cavemanState not wired — surface a clear message.
        emitSlash('caveman: not configured (pass cavemanState to runReplSession)');
      }
      continue;
    }

    // Phase 22: namespaced pack command dispatch. Runs BEFORE /spore built-ins.
    if (opts.sporeRegistry && opts.logger) {
      const result = await dispatch(prompt, {
        registry: opts.sporeRegistry,
        activeSpore: opts.getActiveSpore?.() ?? null,
        cwd: opts.cwd,
        logger: opts.logger,
      });
      if (result.kind === 'expanded-prompt') {
        // Inject the expanded body as a user message. Engine snapshot records it;
        // ConversationLog persists it on turn complete.
        // The expanded body is NEVER re-dispatched even if it starts with '/' —
        // dispatcher fires only on direct REPL input (per spec §2.1 §5).
        engine.appendUser(result.body);
        for await (const ev of runReactLoop({
          client: opts.client,
          engine,
          tools: opts.tools,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
          ...(opts.cavemanState !== undefined ? { cavemanState: opts.cavemanState } : {}),
          cwd: opts.cwd,
        })) {
          opts.onState(ev);
        }
        await opts.onTurnComplete(engine.snapshot());
        continue;
      }
      if (result.kind === 'orchestrator-output') {
        emitSlash(result.text);
        continue;
      }
      // result.kind === 'no-match' — fall through to the existing /spore block.
    }

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
        const previouslyActive = opts.getActiveSpore?.() ?? null;
        const result = await handleSporeUnpin({ cwd: opts.cwd });
        emitSlash(result.message);
        if (result.ok) {
          if (previouslyActive !== null) {
            await opts.teardownMcpSpore?.(previouslyActive);
          }
          opts.onActiveSporeChange?.(null);
        }
        continue;
      }
      if (sub === 'tools') {
        // Phase 23: introspection — show currently visible tool list post-allowlist.
        emitSlash(
          await handleSporeTools({
            tools: opts.tools,
            activeSpore: opts.getActiveSpore?.() ?? null,
          }),
        );
        continue;
      }
      emitSlash(
        `Unknown /spore subcommand: ${sub}. Try: /spore list | /spore pin <name> | /spore unpin | /spore tools`,
      );
      continue;
    }

    engine.appendUser(prompt);
    for await (const ev of runReactLoop({
      client: opts.client,
      engine,
      tools: opts.tools,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.cavemanState !== undefined ? { cavemanState: opts.cavemanState } : {}),
      cwd: opts.cwd,
    })) {
      opts.onState(ev);
    }
    await opts.onTurnComplete(engine.snapshot());
  }
}
