// src/orchestrator/context.ts
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProjectClaudeMd } from '../memory/claudeMd.js';
import { isSecretFile } from '../security/secretFileFilter.js';

// Phase 16 review (MAJOR-1): the secret-file filter previously lived inline here
// and protected only the system-prompt's `cwd entries:` injection. The same
// filter must apply to `src/tools/listDir.ts` (the agent-facing list_dir tool)
// so an execution sub-agent cannot bypass the system-prompt filter and read
// secret-adjacent filenames via tool dispatch. The filter logic now lives in
// `src/security/secretFileFilter.ts` and is shared by both callers.

export type SessionContext = {
  cwd: string;
  claudeMd: string;
  memoryDir: string;
  /** Output of `git status --porcelain` from cwd. Empty string if not a git repo or git unavailable. */
  gitStatus: string;
  /** Sorted top-level directory entries (filenames only). Empty array on read failure. */
  dirEntries: string[];
};

/**
 * Run a command with spawn and collect stdout as a string.
 * Resolves to empty string on any error (non-zero exit, ENOENT, etc.)
 */
function spawnCollect(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    if (!proc.stdout) {
      resolve('');
      return;
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.on('close', (code) => {
      // git exits non-zero (e.g. 128) when not a repo; treat as empty
      resolve(code === 0 ? stdout.trim() : '');
    });
    proc.on('error', () => {
      resolve('');
    });
  });
}

/**
 * List top-level entries in `cwd`, sorted alphabetically.
 * Returns empty array if the directory does not exist or can't be read.
 */
async function listDirEntries(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd);
    return entries.filter((name) => !isSecretFile(name)).sort();
  } catch {
    return [];
  }
}

export async function senseContext(opts: {
  cwd: string;
  memoryDirName?: string;
}): Promise<SessionContext> {
  const memoryDir = join(opts.cwd, opts.memoryDirName ?? '.myceliate');

  const [claudeMd, gitStatus, dirEntries] = await Promise.all([
    loadProjectClaudeMd(opts.cwd),
    spawnCollect('git', ['status', '--porcelain'], opts.cwd),
    listDirEntries(opts.cwd),
  ]);

  return {
    cwd: opts.cwd,
    claudeMd,
    memoryDir,
    gitStatus,
    dirEntries,
  };
}

/** Cap on the number of cwd entries appended to the system prompt. */
const DIR_ENTRIES_CAP = 50;

/**
 * Assemble the system prompt sent to the orchestrator. Combines the project's
 * CLAUDE.md (or a fallback) with a "session ground truth" block carrying the
 * cwd absolute path, the porcelain git status, and the cwd top-level listing.
 *
 * The cwd path is load-bearing: without it the model hallucinates Docker /
 * devcontainer defaults (`/home/user`, `/workspace`) when emitting absolute-
 * path tool calls (e.g. `read_file('/home/user/CLAUDE.md')`), because the
 * filename listing alone gives no anchor for where those files actually live.
 *
 * Pure helper so it can be unit-tested without driving `main()`'s side effects.
 */
export function buildSystemPrompt(ctx: SessionContext): string {
  const base = ctx.claudeMd || 'You are myceliate, an autonomous CLI agent.';
  const gitLine = ctx.gitStatus.length > 0 ? ctx.gitStatus : '(clean / not a repo)';
  const entries = ctx.dirEntries;
  const entryList =
    entries.length > DIR_ENTRIES_CAP
      ? `${entries.slice(0, DIR_ENTRIES_CAP).join(', ')}, ...`
      : entries.join(', ');
  return `${base}\n\n## session ground truth\ncwd: ${ctx.cwd}\ngit status:\n${gitLine}\n\ncwd entries: ${entryList}\n`;
}
