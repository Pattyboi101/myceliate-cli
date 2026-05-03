// tests/integration/bashToolE2E.test.ts
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisConnectionOptions } from '../../src/queue/connection.js';
import { runBashJob } from '../../src/queue/jobs/bashJob.js';
import { type BashJobData, type BashJobReturn, QUEUE_NAMES } from '../../src/queue/queues.js';
import { HitlGate } from '../../src/security/hitlGate.js';
import { createBashTool } from '../../src/tools/bash.js';

// BullMQ Worker uses blocking XREAD on its connection; sharing the singleton
// with Queue + QueueEvents causes deadlocks. Create three dedicated connections
// for the test's lifetime so each BullMQ primitive gets its own Redis handle.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe.skipIf(!process.env.REDIS_URL && !process.env.MYC_REDIS_E2E)(
  'bash tool E2E (real Redis + worker)',
  () => {
    let queue: Queue<BashJobData, BashJobReturn>;
    let queueEvents: QueueEvents;
    let worker: Worker<BashJobData, BashJobReturn>;
    let connQueue: Redis;
    let connEvents: Redis;
    let connWorker: Redis;

    beforeAll(async () => {
      const opts = redisConnectionOptions(REDIS_URL);
      connQueue = new Redis(opts);
      connEvents = new Redis(opts);
      connWorker = new Redis(opts);

      queue = new Queue<BashJobData, BashJobReturn>(QUEUE_NAMES.bash, {
        connection: connQueue,
      });
      queueEvents = new QueueEvents(QUEUE_NAMES.bash, { connection: connEvents });
      worker = new Worker<BashJobData, BashJobReturn>(
        QUEUE_NAMES.bash,
        async (job) =>
          runBashJob({
            command: job.data.command,
            cwd: job.data.cwd,
            timeoutMs: job.data.timeoutMs,
          }),
        { connection: connWorker, concurrency: 1 },
      );
      await queueEvents.waitUntilReady();
    });

    afterAll(async () => {
      await worker.close();
      await queueEvents.close();
      await queue.close();
      await connQueue.quit();
      await connEvents.quit();
      await connWorker.quit();
    });

    it('runs a benign command end-to-end via the worker', async () => {
      const hitl = new HitlGate({
        requestApproval: async () => ({ decision: 'approve' }),
      });
      const tool = createBashTool({ hitl, queue, queueEvents, defaultTimeoutMs: 5_000 });
      const out = await tool.run(
        { command: 'echo myceliate' },
        { cwd: process.cwd(), abort: new AbortController().signal },
      );
      expect(out).toContain('exitCode: 0');
      expect(out).toContain('myceliate');
    }, 15_000);

    it('surfaces non-zero exit code without throwing', async () => {
      const hitl = new HitlGate({
        requestApproval: async () => ({ decision: 'approve' }),
      });
      const tool = createBashTool({ hitl, queue, queueEvents, defaultTimeoutMs: 5_000 });
      const out = await tool.run(
        { command: 'sh -c "exit 7"' },
        { cwd: process.cwd(), abort: new AbortController().signal },
      );
      expect(out).toContain('exitCode: 7');
    }, 15_000);
  },
);
