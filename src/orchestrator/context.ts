// src/orchestrator/context.ts
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProjectClaudeMd } from '../memory/claudeMd.js';

/**
 * Filenames stripped from `dirEntries` before injection into the system prompt.
 * Filename leakage (the entry NAMES, not contents) gives the LLM a hint about
 * the project's secret-adjacent surface; this filter prevents `.env`,
 * `secrets.json`, `id_rsa`, etc. from appearing in the prompt's "cwd entries:"
 * line. Contents are NEVER disclosed by senseContext — this is a defense-in-depth
 * filter on names only.
 *
 * To extend: add to SECRET_FILE_NAMES (exact match) or SECRET_FILE_EXTENSIONS
 * (suffix match). Both checks are case-sensitive — file systems vary, but the
 * LLM-facing prompt is opt-in over-redaction.
 *
 * Known limitation: on case-insensitive filesystems (macOS HFS+/APFS default),
 * `.ENV` or `ID_RSA` would slip through. Linux (case-sensitive) is the target
 * platform for v1.2; re-evaluate in v2 if macOS support is added.
 */
const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.git',
  '.myceliate',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'secrets.json',
  'credentials',
  'credentials.json',
]);

const SECRET_FILE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.cer', '.crt']);

function isSecretFile(name: string): boolean {
  if (SECRET_FILE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot);
    if (SECRET_FILE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

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
 * porcelain git status and the cwd top-level listing — both of which
 * `senseContext` runs on every session start but were previously thrown away.
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
  return `${base}\n\n## session ground truth\ngit status:\n${gitLine}\n\ncwd entries: ${entryList}\n`;
}
