// src/util/logger.ts
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
  debug: (entry: Record<string, unknown>) => void;
  info: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

function safeStringify(level: LogLevel, entry: Record<string, unknown>): string {
  try {
    return JSON.stringify({ ts: new Date().toISOString(), level, ...entry });
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level, msg: '[unserializable]' });
  }
}

export function createLogger(opts: { logsDir: string; file?: string }): Logger {
  // basename() to prevent path traversal via opts.file. Internal callers only,
  // but cheap defence-in-depth keeps the boundary explicit.
  const file = basename(opts.file ?? 'session.log');
  const queue: string[] = [];
  // The `pending` chain must never reject — a rejected Promise poisons every
  // subsequent .then() body, silently dropping all future writes for the rest
  // of the session. The trailing .catch keeps the chain in a fulfilled state
  // so a single I/O failure (EIO, ENOSPC, EACCES) drops only the failing batch.
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (level: LogLevel, entry: Record<string, unknown>): void => {
    queue.push(`${safeStringify(level, entry)}\n`);
    pending = pending
      .then(async () => {
        const batch = queue.splice(0).join('');
        if (!batch) return;
        await mkdir(opts.logsDir, { recursive: true });
        await appendFile(join(opts.logsDir, file), batch, 'utf8');
      })
      .catch(() => {
        // Drop the batch; keep the chain alive for subsequent enqueues.
      });
  };

  return {
    debug: (e) => enqueue('debug', e),
    info: (e) => enqueue('info', e),
    warn: (e) => enqueue('warn', e),
    error: (e) => enqueue('error', e),
    flush: async () => {
      await pending;
    },
  };
}
