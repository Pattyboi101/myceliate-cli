import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnRequest } from '../tools/spawn_subagent.js';
import { type SpawnResponse, SpawnResponseSchema } from '../tools/spawn_subagent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Dev/prod detection: when tsx runs the source TypeScript, `import.meta.url`
// for this module resolves to a `.ts` URL. In a built deployment the same
// file is loaded as `.js`. We use that to pick the right sibling for the
// subagent runner (subagentRunner.ts in dev, subagentRunner.js in prod) and
// to gate the `--import tsx` loader flag on the spawned Node child.
//
// The bug this fixes (surfaced by T19 manual smoke 2026-05-15): in dev mode
// the legacy `resolve(HERE, 'subagentRunner.js')` pointed at a file that
// never existed (only `.ts` lives in src/). The Node spawn ENOENT'd in
// ~300ms, the orchestrator's child_process.on('error') handler returned
// `{ok: false, error: 'spawn failed: ENOENT'}` to the orchestrator, and the
// orchestrator silently fell back to its own parallel read_file / grep
// dispatch. Subagents have not actually executed in dev sessions since
// at least Phase 1, masked entirely by the orchestrator's self-healing
// ReAct loop. This pattern has been with us all along — T19's literal
// criterion-1 verification (subagent dispatches log Flash) was the first
// place it could surface, because every prior verification path treated
// the orchestrator's recovered response as proof the spawn worked.
const IS_DEV = import.meta.url.endsWith('.ts');
const RUNNER_PATH = resolve(HERE, IS_DEV ? 'subagentRunner.ts' : 'subagentRunner.js');
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
    // tsx loader is prefixed when the spawned file is a TypeScript source
    // (dev) so Node can resolve and execute it. The decision is keyed off
    // the actual file extension, NOT the module-level IS_DEV flag — that
    // way unit tests (which inject built `.js` fixtures via the runnerPath
    // DI parameter) skip the loader cleanly. tsx must be resolvable from
    // the child's cwd; child inherits parent's cwd via Node default, which
    // in dev points at the project root where node_modules/.bin/tsx lives.
    const execArgs = runnerPath.endsWith('.ts') ? ['--import', 'tsx', runnerPath] : [runnerPath];
    const child = nodeSpawn(execPath, execArgs, {
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
