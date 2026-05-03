#!/usr/bin/env node
// Phase 12.7 — `myceliate` global command shim.
//
// Spawns Node with tsx as a loader so src/index.ts runs directly without a
// build step. Forwards args, signals, and stdio so the Ink TUI gets a real
// TTY (Tab toggle / Ctrl+D / colour rendering all work as if `pnpm dev` were
// run from the project root).
//
// Installed via `pnpm link --global` from the project root. After link, the
// command is available system-wide and operates on the user's cwd at
// invocation time (not the install dir).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const entry = join(projectRoot, 'src', 'index.ts');

const child = spawn(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

// Forward common termination signals so Ctrl+C / SIGTERM reach the agent.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
