// src/queue/worker.ts
//
// BullMQ worker entry point. Two ways this gets invoked:
//   (1) Indirectly by orchestrator boot via startWorker() in src/runtime/workerLifecycle.ts.
//       This is the production path; stdio is routed to .myceliate/logs/worker.log.
//   (2) Manually as `pnpm queue:worker` in a developer terminal when an implementer
//       wants to see live worker output without the log-file routing layer
//       (e.g. attaching a debugger, watching stderr in real time).
import { QueueEvents, Worker } from 'bullmq';
import { closeRedis, getRedis } from './connection.js';
import { runBashJob } from './jobs/bashJob.js';
import { type BashJobData, type BashJobReturn, QUEUE_NAMES } from './queues.js';

const worker = new Worker<BashJobData, BashJobReturn>(
  QUEUE_NAMES.bash,
  async (job) =>
    runBashJob({
      command: job.data.command,
      cwd: job.data.cwd,
      timeoutMs: job.data.timeoutMs,
      ...(job.data.maxBytes !== undefined ? { maxBytes: job.data.maxBytes } : {}),
    }),
  { connection: getRedis(), concurrency: 4 },
);

const events = new QueueEvents(QUEUE_NAMES.bash, { connection: getRedis() });
events.on('completed', ({ jobId, returnvalue }) => {
  console.log(JSON.stringify({ event: 'completed', jobId, returnvalue }));
});
events.on('failed', ({ jobId, failedReason }) => {
  console.log(JSON.stringify({ event: 'failed', jobId, failedReason }));
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Each await wrapped so a failure in one step doesn't leak the rest. Idempotent on second signal.
  try {
    await worker.close();
  } catch {
    /* idempotent */
  }
  try {
    await events.close();
  } catch {
    /* idempotent */
  }
  try {
    await closeRedis();
  } catch {
    /* idempotent */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[worker] consuming queue: ${QUEUE_NAMES.bash} (concurrency=4)`);
