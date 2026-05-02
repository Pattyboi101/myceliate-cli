// src/queue/queues.ts
import { Queue } from 'bullmq';
import { getRedis } from './connection.js';
import type { BashJobInput, BashJobResult } from './jobs/bashJob.js';

export const QUEUE_NAMES = { bash: 'bash', test: 'test', docker: 'docker' } as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type BashJobData = BashJobInput & { toolUseId: string };
export type BashJobReturn = BashJobResult;

export const bashQueue = (): Queue<BashJobData, BashJobReturn> =>
  new Queue<BashJobData, BashJobReturn>(QUEUE_NAMES.bash, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
