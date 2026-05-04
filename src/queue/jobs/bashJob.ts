// src/queue/jobs/bashJob.ts
import { spawn } from 'node:child_process';

/**
 * Hermetic safelist of env vars passed to the bash subprocess.
 *
 * Replaces parent env inheritance so secrets like DEEPSEEK_API_KEY,
 * AWS_PROFILE, SSH_AUTH_SOCK never reach the subprocess execution boundary.
 * v1.1's three-channel redaction (egress F1, disk Task 81a, UI Phase 13)
 * catches secrets downstream — this hardens the upstream by construction.
 *
 * PATH is non-negotiable (without it bash can't resolve `ls`, `cat`, etc.).
 * HOME is needed for `~/` shell expansions. USER/PWD/TERM/LANG/LC_ALL are
 * inherited by every process anyway; stripping produces noisy diffs from
 * normal shell behaviour without security benefit.
 *
 * To add a new safelisted var: include in this list AND document the threat
 * model implication. Defense-in-depth only works if the list stays small.
 */
const SAFELISTED_ENV_KEYS = ['PATH', 'HOME', 'USER', 'PWD', 'TERM', 'LANG', 'LC_ALL'] as const;

function buildSafeEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of SAFELISTED_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

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
      env: buildSafeEnv(process.env),
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

    // Catches spawn-time failures (invalid cwd, ENOENT, permission denied) so the Promise
    // resolves cleanly instead of the unhandled EventEmitter error crashing the worker.
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr || `spawn error: ${err.message}`,
        truncated,
        timedOut,
      });
    });
  });
}
