// src/util/logger.ts
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
  debug: (entry: Record<string, unknown>) => void;
  info: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

export function createLogger(opts: { logsDir: string; file?: string }): Logger {
  const file = opts.file ?? 'session.log';
  const queue: string[] = [];
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (level: LogLevel, entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...entry });
    queue.push(`${line}\n`);
    pending = pending.then(async () => {
      const batch = queue.splice(0).join('');
      if (!batch) return;
      await mkdir(opts.logsDir, { recursive: true });
      await appendFile(join(opts.logsDir, file), batch, 'utf8');
    });
  };

  return {
    debug: (e) => enqueue('debug', e),
    info: (e) => enqueue('info', e),
    warn: (e) => enqueue('warn', e),
    error: (e) => enqueue('error', e),
    flush: async () => { await pending; },
  };
}
