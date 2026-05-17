// src/runtime/workerLifecycle.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRedis } from '../queue/connection.js';
import type { Logger } from '../util/logger.js';

// Resolve the myceliate-cli package root relative to THIS file so `pnpm queue:worker`
// can find package.json regardless of the user's cwd.
//   dev:  src/runtime/workerLifecycle.ts → ../.. = myceliate-cli/
//   prod: dist/runtime/workerLifecycle.js → ../.. = myceliate-cli/
// Without this, spawn('pnpm', ...) inherits the user's cwd; running myceliate from
// any directory without a package.json (e.g. /tmp) fails with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND
// in worker.log and the bash tool then crashes via WorkerCrashedError. Pre-existing
// since v1.1; surfaced by Phase 1's stdio→worker.log routing during the v1.5 smoke audit.
const myceliateCliRoot = fileURLToPath(new URL('../..', import.meta.url));

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
  // Redis pre-flight ping — fail-fast with a clean diagnostic if Redis is down.
  try {
    await getRedis(opts.redisUrl).ping();
  } catch (err) {
    throw new RedisUnavailableError(err instanceof Error ? err : new Error(String(err)));
  }

  // Phase 14 review m2 fix: stdout/stderr are 'pipe' (not 'inherit') because
  // the parent has Ink mounted — direct worker writes to the parent's stdout
  // would corrupt the TUI per U4. Pipes are routed to the worker log file
  // (Task 4) instead of being discarded via .resume().
  const child = spawn('pnpm', ['queue:worker'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: myceliateCliRoot,
    env: { ...process.env, REDIS_URL: opts.redisUrl },
    detached: false,
  });
  mkdirSync(opts.logsDir, { recursive: true });
  const workerLog = createWriteStream(join(opts.logsDir, 'worker.log'), { flags: 'a' });
  child.stdout?.pipe(workerLog);
  child.stderr?.pipe(workerLog);
  // Phase 14 review m1 fix: spawn 'error' (ENOENT/EACCES) is otherwise an
  // unhandled EventEmitter error that crashes main. Surface it via stderr
  // before Ink mounts.
  child.on('error', (err) => {
    process.stderr.write(`[workerLifecycle] spawn error: ${err.message}\n`);
  });
  // Task 5: Map-backed pending-jobs registry for ~100ms crash detection.
  const pendingJobs = new Map<string, (err: Error) => void>();
  const trackJob: WorkerHandle['trackJob'] = (jobId, reject) => {
    pendingJobs.set(jobId, reject);
  };
  const releaseJob: WorkerHandle['releaseJob'] = (jobId) => {
    pendingJobs.delete(jobId);
  };
  // Task 6 + post-review fix: single shutdownInitiated flag covers BOTH the crash-
  // handler suppression (so a SIGTERM-triggered exit doesn't fan out as a crash) AND
  // the shutdown() idempotency guard. The earlier two-flag scheme (shutdownInitiated +
  // shuttingDown) was redundant — code-quality review flagged the ordering subtlety.
  let shutdownInitiated = false;
  // Crash handler — distinguishes clean shutdown from unexpected exit. Also closes the
  // worker.log WriteStream so the file descriptor doesn't leak across worker restarts.
  child.on('exit', (code, signal) => {
    workerLog.end();
    if (shutdownInitiated) {
      opts.logger.info({ event: 'worker_shutdown_complete', code, signal });
      return;
    }
    if (code !== 0 || pendingJobs.size > 0) {
      const pendingIds = [...pendingJobs.keys()];
      opts.logger.error({
        event: 'worker_crashed',
        exitCode: code,
        signal,
        pendingJobs: pendingIds,
      });
      const err = new WorkerCrashedError(code, signal);
      for (const reject of pendingJobs.values()) {
        reject(err);
      }
      pendingJobs.clear();
    }
  });
  const shutdown = async (): Promise<void> => {
    if (shutdownInitiated) return;
    shutdownInitiated = true;
    if (child.exitCode !== null) {
      workerLog.end(); // child already exited; exit handler may not have fired
      return;
    }
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
  return { child, trackJob, releaseJob, shutdown };
}
