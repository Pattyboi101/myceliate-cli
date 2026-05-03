// src/runtime/workerLifecycle.ts
import { type ChildProcess, spawn } from 'node:child_process';

export type WorkerHandle = {
  child: ChildProcess;
  shutdown: () => Promise<void>;
};

/**
 * Spawn `pnpm queue:worker` as a child subprocess so the bash tool's BullMQ
 * jobs have a consumer. Returns a handle exposing the child and an idempotent
 * `shutdown` that SIGTERM-then-SIGKILLs. Second `shutdown()` callers receive
 * an immediately-resolved promise (no-op).
 *
 * Caller is responsible for calling `shutdown()` in the main `try/finally`
 * block alongside `ink.unmount()` and `logger.flush()`.
 */
export function startWorker(): WorkerHandle {
  // Phase 14 review m2 fix: stdout/stderr are 'pipe' (not 'inherit') because
  // the parent has Ink mounted — direct worker writes to the parent's stdout
  // would corrupt the TUI per U4. Pipes are immediately drained via `.resume()`
  // so the ~64KB pipe buffer never fills (which would block the worker on its
  // next write). v1.2 may redirect these into the file-only logger for debug
  // visibility; for v1.1 the worker's diagnostic output is silently discarded.
  const child = spawn('pnpm', ['queue:worker'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  // Phase 14 review m1 fix: spawn 'error' (ENOENT/EACCES) is otherwise an
  // unhandled EventEmitter error that crashes main. Surface it via stderr
  // before Ink mounts; absence of a live worker will subsequently surface
  // as a queue-add timeout when the LLM tries to invoke bash.
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
  return { child, shutdown };
}
