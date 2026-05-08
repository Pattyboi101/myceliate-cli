import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnRequest } from '../tools/spawn_subagent.js';
import { type SpawnResponse, SpawnResponseSchema } from '../tools/spawn_subagent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(HERE, 'subagentRunner.js');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// I1: forward adapter/model/base-URL env vars so the sub-agent can connect
// to the same DeepSeek endpoint as the parent process.
const ALLOWED_ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_ADAPTER',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'NODE_OPTIONS',
  'PATH',
  'HOME',
  'TMPDIR',
];

export async function childProcessSpawn(
  req: SpawnRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runnerPath = RUNNER_PATH,
  execPath = process.execPath,
): Promise<SpawnResponse> {
  return new Promise((resolveP) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    const child = nodeSpawn(execPath, [runnerPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let resolved = false;
    const safeResolve = (response: SpawnResponse): void => {
      if (resolved) return;
      resolved = true;
      resolveP(response);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      safeResolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        safeResolve({ ok: false, error: 'sub-agent timeout', stderr_tail: stderrBuf.slice(-500) });
        return;
      }
      if (code !== 0) {
        safeResolve({
          ok: false,
          error: `sub-agent exit ${code}`,
          stderr_tail: stderrBuf.slice(-500),
        });
        return;
      }
      try {
        const lastLine = stdoutBuf.trim().split('\n').pop() ?? '{}';
        const raw: unknown = JSON.parse(lastLine);
        const parsed = SpawnResponseSchema.parse(raw);
        safeResolve(parsed);
      } catch (err) {
        safeResolve({
          ok: false,
          error: `invalid sub-agent response: ${(err as Error).message}`,
          stderr_tail: stdoutBuf.slice(-500),
        });
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}
