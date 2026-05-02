// src/queue/jobs/bashJob.ts
import { spawn } from 'node:child_process';

export type BashJobInput = {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Default 1 MiB; output beyond is dropped and `truncated` is set. */
  maxBytes?: number;
};

export type BashJobResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export function runBashJob(input: BashJobInput): Promise<BashJobResult> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', input.command], {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Guard against stdio: spawn overload doesn't narrow child.stdout/stderr to non-null.
    if (!child.stdout || !child.stderr) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: 'spawn produced no streams',
        truncated: false,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const cap = (existing: string, chunk: Buffer): { next: string; truncated: boolean } => {
      if (existing.length >= maxBytes) return { next: existing, truncated: true };
      const remaining = maxBytes - existing.length;
      const piece =
        chunk.length > remaining
          ? chunk.subarray(0, remaining).toString('utf8')
          : chunk.toString('utf8');
      return { next: existing + piece, truncated: chunk.length > remaining };
    };

    child.stdout.on('data', (c: Buffer) => {
      const r = cap(stdout, c);
      stdout = r.next;
      if (r.truncated) truncated = true;
    });
    child.stderr.on('data', (c: Buffer) => {
      const r = cap(stderr, c);
      stderr = r.next;
      if (r.truncated) truncated = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, truncated, timedOut });
    });
  });
}
