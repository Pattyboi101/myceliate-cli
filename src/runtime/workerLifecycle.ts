// src/runtime/workerLifecycle.ts
import { type ChildProcess, spawn } from 'node:child_process';

export type WorkerHandle = {
  child: ChildProcess;
  shutdown: () => Promise<void>;
};

/**
 * Spawn `pnpm queue:worker` as a detached subprocess so the bash tool's
 * BullMQ jobs have a consumer. Returns a handle exposing the child and
 * an idempotent `shutdown` that SIGTERM-then-SIGKILLs.
 *
 * Caller is responsible for calling `shutdown()` in the main `try/finally`
 * block alongside `ink.unmount()` and `logger.flush()`.
 */
export function startWorker(): WorkerHandle {
  const child = spawn('pnpm', ['queue:worker'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
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
  return { child, shutdown };
}
