// tests/integration/queueRoundTrip.test.ts
import { QueueEvents, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis } from '../../src/queue/connection.js';
import { runBashJob } from '../../src/queue/jobs/bashJob.js';
import {
  type BashJobData,
  type BashJobReturn,
  QUEUE_NAMES,
  bashQueue,
} from '../../src/queue/queues.js';

const skip = !process.env.REDIS_URL;
const d = skip ? describe.skip : describe;

d('queue round-trip (requires Redis)', () => {
  let worker: Worker<BashJobData, BashJobReturn>;
  let events: QueueEvents;

  beforeAll(() => {
    worker = new Worker<BashJobData, BashJobReturn>(
      QUEUE_NAMES.bash,
      async (job) =>
        runBashJob({ command: job.data.command, cwd: job.data.cwd, timeoutMs: job.data.timeoutMs }),
      { connection: getRedis(), concurrency: 1 },
    );
    events = new QueueEvents(QUEUE_NAMES.bash, { connection: getRedis() });
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await closeRedis();
  });

  it('enqueues a bash job and receives the result', async () => {
    const queue = bashQueue();
    const job = await queue.add('test-echo', {
      toolUseId: 'tu1',
      command: 'echo round-trip',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('round-trip');
    await queue.close();
  });

  it('captures stderr and non-zero exit code through the queue', async () => {
    const queue = bashQueue();
    const job = await queue.add('test-error', {
      toolUseId: 'tu2',
      command: 'echo error-out >&2; exit 42',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result.exitCode).toBe(42);
    expect(result.stderr.trim()).toBe('error-out');
    expect(result.stdout).toBe('');
    await queue.close();
  });
});
