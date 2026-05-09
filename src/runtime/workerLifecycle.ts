// src/runtime/workerLifecycle.ts
import { type ChildProcess, spawn } from 'node:child_process';
import type { Logger } from '../util/logger.js';

export type WorkerHandle = {
  child: ChildProcess;
  /** Register an in-flight bash job; lifecycle calls reject() on worker crash. */
  trackJob: (jobId: string, reject: (err: Error) => void) => void;
  /** Bash job completed/failed normally — drop from pending registry. */
  releaseJob: (jobId: string) => void;
  /** SIGTERM → 2s wait → SIGKILL. Idempotent. */
  shutdown: () => Promise<void>;
};

export class RedisUnavailableError extends Error {
  constructor(cause?: Error) {
    super(
      'myceliate: Redis is required for bash execution. ' +
        'Run `docker compose up -d redis` and try again.',
      cause ? { cause } : undefined,
    );
    this.name = 'RedisUnavailableError';
  }
}

export class WorkerCrashedError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
  ) {
    super(`BullMQ worker crashed (code=${exitCode}, signal=${signal})`);
    this.name = 'WorkerCrashedError';
  }
}

/**
 * Spawn `pnpm queue:worker` as a child subprocess so the bash tool's BullMQ
 * jobs have a consumer. Returns a handle exposing the child, pending-jobs
 * methods, and an idempotent `shutdown` that SIGTERM-then-SIGKILLs.
 *
 * v1.5 Hyphal Continuity additions (vs v1.1 Phase 14):
 * - async signature with redisUrl + logger opts
 * - Redis pre-flight ping (Task 2)
 * - REDIS_URL injected explicitly into child env (Task 3)
 * - stdout/stderr piped to .myceliate/logs/worker.log instead of .resume()-discarded (Task 4)
 * - trackJob/releaseJob pending-jobs Map for ~100ms crash detection (Task 5)
 * - shutdownInitiated flag distinguishing clean shutdown from crash exit (Task 6)
 *
 * Caller is responsible for calling `shutdown()` in the main `try/finally`
 * block alongside `ink.unmount()` and `logger.flush()`.
 */
export async function startWorker(opts: {
  redisUrl: string;
  logger: Logger;
  logsDir: string;
}): Promise<WorkerHandle> {
  // opts referenced for now to satisfy noUnusedParameters; later tasks consume them.
  void opts;

  // Phase 14 review m2 fix: stdout/stderr are 'pipe' (not 'inherit') because
  // the parent has Ink mounted — direct worker writes to the parent's stdout
  // would corrupt the TUI per U4. Pipes are immediately drained via `.resume()`
  // so the ~64KB pipe buffer never fills (which would block the worker on its
  // next write). Task 4 will replace `.resume()` with file-stream piping.
  const child = spawn('pnpm', ['queue:worker'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  // Phase 14 review m1 fix: spawn 'error' (ENOENT/EACCES) is otherwise an
  // unhandled EventEmitter error that crashes main. Surface it via stderr
  // before Ink mounts.
  child.on('error', (err) => {
    process.stderr.write(`[workerLifecycle] spawn error: ${err.message}\n`);
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode !== null) return; // already exited
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  // No-op stubs — Task 5 implements the real Map-backed pending-jobs registry.
  const trackJob: WorkerHandle['trackJob'] = () => {};
  const releaseJob: WorkerHandle['releaseJob'] = () => {};
  return { child, trackJob, releaseJob, shutdown };
}
