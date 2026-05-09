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
import { readFileTool } from '../tools/readFile.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSpawnSubagentTool } from '../tools/spawn_subagent.js';
import { writeFileTool } from '../tools/writeFile.js';
import type { Logger } from '../util/logger.js';
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
}

export interface BootToolsResult {
  tools: ToolRegistry;
  setActiveSpore: (name: string | null) => void;
}

// Minimal stub schema for bash in test contexts without a real queue.
const BashStubSchema = z.object({ command: z.string().min(1) }).strict();

export function bootTools(opts: BootToolsOpts): BootToolsResult {
  const tools = new ToolRegistry();

  tools.register(readFileTool);
  tools.register(writeFileTool);
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
      inputSchema: BashStubSchema,
      run: async () => 'bash stub: not available in test context',
    });
  }

  const germinateTool = createGerminateSporeTool({
    registry: opts.registry,
    cwd: opts.cwd ?? process.cwd(),
    emit: opts.emit ?? ((_ev) => {}),
    appendSystemPrompt: opts.appendSystemPrompt ?? ((_section) => {}),
  });
  // Wrap germinate_spore to fit ToolRegistry's Tool<Input> interface.
  tools.register({
    name: 'germinate_spore',
    description: germinateTool.description,
    capability: 'coordination' as const,
    inputSchema: germinateTool.inputSchema,
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
    spawn: (req) => childProcessSpawn(req),
  });
  // Wrap spawn_subagent to fit ToolRegistry's Tool<Input> interface.
  tools.register({
    name: 'spawn_subagent',
    description: spawnTool.description,
    capability: 'coordination' as const,
    inputSchema: spawnTool.inputSchema,
    run: async (input, _ctx) => {
      const result = await spawnTool.handler(input);
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

  return { tools, setActiveSpore };
}
