import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnRequest, SpawnResponse } from '../tools/spawn_subagent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(HERE, 'subagentRunner.js');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const ALLOWED_ENV_KEYS = ['DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'PATH', 'HOME', 'TMPDIR'];

export async function childProcessSpawn(
  req: SpawnRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResponse> {
  return new Promise((resolveP) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    const child = nodeSpawn(process.execPath, [RUNNER_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveP({
          ok: false,
          error: 'sub-agent timeout',
          stderr_tail: stderrBuf.slice(-500),
        });
        return;
      }
      if (code !== 0) {
        resolveP({
          ok: false,
          error: `sub-agent exit ${code}`,
          stderr_tail: stderrBuf.slice(-500),
        });
        return;
      }
      try {
        const lastLine = stdoutBuf.trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(lastLine) as SpawnResponse;
        resolveP(parsed);
      } catch (err) {
        resolveP({
          ok: false,
          error: `invalid JSON from sub-agent: ${(err as Error).message}`,
          stderr_tail: stdoutBuf.slice(-500),
        });
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}
