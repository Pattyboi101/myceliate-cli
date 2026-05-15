import type { Queue, QueueEvents } from 'bullmq';
// src/runtime/bootTools.ts
import { z } from 'zod';
import type { BashJobData, BashJobReturn } from '../queue/queues.js';
import type { HitlGate } from '../security/hitlGate.js';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { childProcessSpawn } from '../spores/childProcessSpawn.js';
import { createBashTool } from '../tools/bash.js';
import { createGerminateSporeTool } from '../tools/germinate_spore.js';
import { grepTool } from '../tools/grep.js';
import { listDirTool } from '../tools/listDir.js';
import { createReadFileTool } from '../tools/readFile.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSpawnSubagentTool } from '../tools/spawn_subagent.js';
import { createWriteFileTool } from '../tools/writeFile.js';
import type { Logger } from '../util/logger.js';
import type { CavemanState } from './cavemanMode.js';
import type { McpLifecycle } from './mcpLifecycle.js';
import type { WorkerHandle } from './workerLifecycle.js';

export interface BootToolsOpts {
  hitl: HitlGate;
  /** Required for bash tool job dispatch (may be omitted in tests that don't run bash). */
  queue?: Queue<BashJobData, BashJobReturn>;
  /** Required for bash tool completion events (may be omitted in tests that don't run bash). */
  queueEvents?: QueueEvents;
  /** Required for real bash registration — enables crash detection via pending-jobs Map. */
  worker?: WorkerHandle;
  registry: SporeRegistry;
  cwd?: string;
  logger: Logger;
  // Callbacks the existing index.ts threads into createGerminateSporeTool, etc.
  emit?: Parameters<typeof createGerminateSporeTool>[0]['emit'];
  appendSystemPrompt?: Parameters<typeof createGerminateSporeTool>[0]['appendSystemPrompt'];
  activeSporeRef?: () => string | null;
  setActiveSporeFromGerminate?: (name: string) => void;
  /** Phase 23 Case 8: surface allowlist drift events to the UI (yellow boot
   * banner) so the user is never silently in a fully privileged execution
   * state when they expected a sandboxed orchestrator. Fires for stale-pin
   * fallback, unknown allowlist entries, and coordination-tool stripping. */
  onUserVisibleWarning?: (msg: string) => void;
  /**
   * Phase 3 (T27): MCP server lifecycle owner. Constructed by main() and
   * threaded here so germinate_spore (T28) can spawn/own MCP server children.
   * Optional so tests and callers that pre-date Phase 3 don't need to supply it.
   * When absent, teardownMcpSpore is a no-op for the lifecycle.teardown call.
   */
  mcpLifecycle?: McpLifecycle;
  /**
   * Phase 2.5: mutable caveman state created at boot. Forwarded into the
   * spawn_subagent tool wrapper so the subagent subprocess receives the current
   * active flag via the SpawnRequest JSON payload (scalar boolean crossing the
   * process boundary per R8).
   * Optional — when absent, cavemanActive is not included in SpawnRequest.
   */
  cavemanState?: CavemanState;
  /**
   * Fix-pass (review): injectable spawn function for unit tests. When provided,
   * replaces the default `childProcessSpawn` inside the spawn_subagent wrapper
   * so tests can exercise the re-emission path without forking a real subprocess.
   * Production callers MUST NOT supply this — omitting it selects the real spawn.
   */
  _spawnFnOverride?: Parameters<typeof createSpawnSubagentTool>[0]['spawn'];
}

export interface BootToolsResult {
  tools: ToolRegistry;
  setActiveSpore: (name: string | null) => void;
  /**
   * Phase 3 (T27): closure that tears down a single MCP-spore (server + tool
   * wrappers). Wired into mcpLifecycle.opts.onUnexpectedExit (via
   * setOnUnexpectedExit) AND returned here for index.ts's onActiveSporeChange
   * and replSession.ts's /spore unpin handler to call on explicit teardown.
   * Both unexpected and explicit teardowns share one code path.
   */
  teardownMcpSpore: (sporeName: string) => Promise<void>;
}

// Minimal stub schema for bash in test contexts without a real queue.
const BashStubSchema = z.object({ command: z.string().min(1) }).strict();

export function bootTools(opts: BootToolsOpts): BootToolsResult {
  const emit: (ev: Parameters<NonNullable<BootToolsOpts['emit']>>[0]) => void =
    opts.emit ?? ((_ev) => {});
  const tools = new ToolRegistry();

  tools.register(createReadFileTool({ hitl: opts.hitl }));
  tools.register(createWriteFileTool({ hitl: opts.hitl }));
  tools.register(listDirTool);
  tools.register(grepTool);

  // Bash tool requires queue + queueEvents + worker. When any are absent (test stubs),
  // register a no-op stub so the registry shape is complete but no real jobs
  // are dispatched. Production callers always provide all three.
  if (opts.queue && opts.queueEvents && opts.worker) {
    tools.register(
      createBashTool({
        hitl: opts.hitl,
        queue: opts.queue,
        queueEvents: opts.queueEvents,
        worker: opts.worker,
        defaultTimeoutMs: 30_000,
      }),
    );
  } else {
    tools.register({
      name: 'bash',
      description: 'Execute shell commands (stub — no queue in this context)',
      capability: 'execution',
      inputSchema: { kind: 'zod', zod: BashStubSchema },
      run: async () => 'bash stub: not available in test context',
    });
  }

  const germinateTool = createGerminateSporeTool({
    registry: opts.registry,
    cwd: opts.cwd ?? process.cwd(),
    emit,
    appendSystemPrompt: opts.appendSystemPrompt ?? ((_section) => {}),
    // Phase 3 forward-compat deps (consumed in T28).  Conditional spread avoids
    // exactOptionalPropertyTypes violations when opts.mcpLifecycle is absent.
    ...(opts.mcpLifecycle !== undefined ? { mcpLifecycle: opts.mcpLifecycle } : {}),
    toolRegistry: tools,
    hitlGate: opts.hitl,
  });
  // Wrap germinate_spore to fit ToolRegistry's Tool<Input> interface.
  tools.register({
    name: 'germinate_spore',
    description: germinateTool.description,
    capability: 'coordination' as const,
    inputSchema: { kind: 'zod', zod: germinateTool.inputSchema },
    run: async (input, _ctx) => {
      const result = await germinateTool.handler(input);
      if (result.ok && opts.setActiveSporeFromGerminate) {
        opts.setActiveSporeFromGerminate(result.spore);
      }
      return JSON.stringify(result);
    },
  });

  const spawnTool = createSpawnSubagentTool({
    registry: opts.registry,
    activeSpore: opts.activeSporeRef ?? (() => null),
    // Phase 2.5: forward the current caveman active flag into every SpawnRequest.
    // opts.cavemanState is a mutable reference — reading state.active here (at
    // spawn time, not at bootTools() call time) captures the value the user has
    // set via /caveman up to this moment.
    // _spawnFnOverride is only set by unit tests — production callers omit it.
    spawn: opts._spawnFnOverride
      ? opts._spawnFnOverride
      : (req) =>
          childProcessSpawn({
            ...req,
            ...(opts.cavemanState !== undefined ? { cavemanActive: opts.cavemanState.active } : {}),
          }),
  });
  // Wrap spawn_subagent to fit ToolRegistry's Tool<Input> interface.
  // Phase 2.5 (T37): after the subagent responds, re-emit each progress entry as a
  // `subagent_step` stream event into the orchestrator's own stream so the live
  // telemetry footer (T39/T40) can subscribe without parsing tool_result content.
  // `emit` is the same closure used by `germinate_spore` and `teardownMcpSpore`
  // for their synthetic lifecycle events — the same seam, no new infrastructure.
  tools.register({
    name: 'spawn_subagent',
    description: spawnTool.description,
    capability: 'coordination' as const,
    inputSchema: { kind: 'zod', zod: spawnTool.inputSchema },
    run: async (input, _ctx) => {
      const result = await spawnTool.handler(input);
      if (result.ok) {
        for (const entry of result.progress ?? []) {
          emit({
            type: 'subagent_step',
            step: entry.step,
            durationMs: entry.durationMs,
            model: entry.model,
          });
        }
      }
      return JSON.stringify(result);
    },
  });

  function setActiveSpore(name: string | null): void {
    if (name === null) {
      tools.setActiveAllowlist(null);
      return;
    }
    const spore = opts.registry.get(name);
    if (!spore) {
      opts.logger.warn({ event: 'set_active_spore_unknown', name });
      // Phase 23 Case 8: stale pin → silent fail-open is dangerous. Surface to UI.
      opts.onUserVisibleWarning?.(
        `Pinned spore "${name}" not found — orchestrator running with full execution tool surface.`,
      );
      tools.setActiveAllowlist(null);
      return;
    }
    const allowed = spore.manifest.allowed_tools;
    if (allowed === undefined) {
      tools.setActiveAllowlist(null);
      return;
    }
    const filtered: string[] = [];
    const coordNames = new Set(tools.byCapability('coordination').map((t) => t.name));
    const knownNames = new Set([
      ...tools.byCapability('execution').map((t) => t.name),
      ...tools.byCapability('coordination').map((t) => t.name),
    ]);
    for (const candidate of allowed) {
      if (coordNames.has(candidate)) {
        opts.logger.warn({
          event: 'allowlist_coordination_tool_stripped',
          spore: name,
          tool: candidate,
        });
        opts.onUserVisibleWarning?.(
          `Spore "${name}" lists coordination tool "${candidate}" in allowed_tools — coordination tools are always available; entry has no effect.`,
        );
        continue;
      }
      if (!knownNames.has(candidate)) {
        opts.logger.warn({ event: 'allowlist_unknown_tool', spore: name, tool: candidate });
        opts.onUserVisibleWarning?.(
          `Spore "${name}" lists unknown tool "${candidate}" in allowed_tools — entry dropped.`,
        );
        continue;
      }
      filtered.push(candidate);
    }
    tools.setActiveAllowlist(filtered);
  }

  // Phase 3 (T27): deregistration + teardown closure.  Shared by:
  //   1. mcpLifecycle.onUnexpectedExit (crash path).
  //   2. BootToolsResult.teardownMcpSpore (explicit /spore unpin + onActiveSporeChange paths).
  //
  // Implementation note: opts.mcpLifecycle is optional (pre-Phase-3 callers omit
  // it).  When absent, teardownMcpSpore still deregisters wrappers and emits an
  // event — it just skips the lifecycle.teardown call.  This keeps the closure
  // safe to invoke unconditionally in index.ts/replSession.ts even when MCP is
  // not configured.
  async function teardownMcpSpore(sporeName: string): Promise<void> {
    const removedCount = tools.deregisterByPrefix(`${sporeName}_`);
    if (opts.mcpLifecycle) {
      await opts.mcpLifecycle.teardown(sporeName);
    }
    emit({
      type: 'system_message',
      text: `MCP server for "${sporeName}" terminated; ${removedCount} tool wrapper(s) deregistered.`,
    });
  }

  // Wire the closure as the unexpected-exit handler so crash teardown uses the
  // same path as explicit teardown.  setOnUnexpectedExit is a one-line setter
  // added to McpLifecycle in T27 — see mcpLifecycle.ts for rationale.
  opts.mcpLifecycle?.setOnUnexpectedExit((sporeName) => {
    void teardownMcpSpore(sporeName);
  });

  return { tools, setActiveSpore, teardownMcpSpore };
}
