// src/tools/bash.ts
import { randomUUID } from 'node:crypto';
import type { Queue, QueueEvents } from 'bullmq';
import { z } from 'zod';
import type { BashJobData, BashJobReturn } from '../queue/queues.js';
import type { WorkerHandle } from '../runtime/workerLifecycle.js';
import type { HitlGate } from '../security/hitlGate.js';
import type { Tool } from './registry.js';

// ZodDefault<ZodString>._input is `string | undefined` but _output is `string`.
// Tool<I> requires inputSchema: ZodType<I, _, I> (same input + output type).
// This alias widens the schema variable to ZodType<BashInput> so TypeScript
// accepts the assignment without changing runtime behaviour — at parse time Zod
// still applies the defaults normally.
type BashSchema = z.ZodType<BashInput>;

export type BashToolDeps = {
  hitl: HitlGate;
  queue: Queue<BashJobData, BashJobReturn>;
  queueEvents: QueueEvents;
  worker: WorkerHandle;
  defaultTimeoutMs?: number;
};

// R3 note: `cwd` and `timeoutMs` use `.default()` (not `.optional()`) so that
// `zodToStrictJsonSchema` can handle them without tripping the ZodOptional guard.
// ZodDefault unwraps to its inner type in the JSON Schema, listing both fields
// as required with sensible defaults. The LLM may omit them; Zod fills in the
// default value at parse time.
const BashInput = z.object({
  command: z.string().min(1),
  /** Optional override; defaults to the orchestrator's cwd. Empty string means "use ctx.cwd". */
  cwd: z.string().default(''),
  /** Optional override in ms; defaults to deps.defaultTimeoutMs. 0 means "use deps default". */
  timeoutMs: z.number().int().nonnegative().default(0),
});
type BashInput = z.infer<typeof BashInput>;

function formatResult(r: BashJobReturn): string {
  return [
    `exitCode: ${r.exitCode}`,
    r.timedOut ? 'timedOut: true' : null,
    r.truncated ? 'truncated: true' : null,
    r.stdout ? `stdout:\n${r.stdout}` : null,
    r.stderr ? `stderr:\n${r.stderr}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function createBashTool(deps: BashToolDeps): Tool<BashInput> {
  const defaultTimeout = deps.defaultTimeoutMs ?? 30_000;
  return {
    name: 'bash',
    description:
      'Execute a shell command in the agent cwd. Returns exit code, stdout, stderr, and truncation/timeout flags. Dangerous patterns require HITL approval.',
    capability: 'execution',
    inputSchema: BashInput as BashSchema,
    run: async (input, ctx) => {
      // cwd: use input override if provided (non-empty/non-undefined), otherwise fall back
      // to ctx.cwd. The `||` handles both the Zod-default '' case and the undefined case
      // when run() is called directly (e.g. integration tests) without registry parsing.
      const cwd = input.cwd || ctx.cwd;
      // timeoutMs: use input override if non-zero/non-undefined, otherwise fall back
      // to deps.defaultTimeoutMs. The `||` handles both Zod-default 0 and undefined.
      const timeoutMs = input.timeoutMs || defaultTimeout;

      const verdict = await deps.hitl.checkBash({
        command: input.command,
        cwd,
        requestId: ctx.toolUseId,
      });
      if (!verdict.allowed) {
        // Cross-module string contract: src/orchestrator/reactLoop.ts catch block detects
        // this 'HITL rejected:' prefix to yield tool_result.status='rejected' instead of 'failed'.
        throw new Error(`HITL rejected: ${verdict.feedback}`);
      }

      const toolUseId = randomUUID();
      const job = await deps.queue.add(
        'bash',
        {
          command: input.command,
          cwd,
          timeoutMs,
          toolUseId,
        },
        { jobId: toolUseId },
      );
      let crashReject!: (err: Error) => void;
      const crashPromise = new Promise<never>((_, reject) => {
        crashReject = reject;
      });
      deps.worker.trackJob(toolUseId, crashReject);
      try {
        const result = await Promise.race([job.waitUntilFinished(deps.queueEvents), crashPromise]);
        return formatResult(result);
      } finally {
        deps.worker.releaseJob(toolUseId);
      }
    },
  };
}
