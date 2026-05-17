#!/usr/bin/env node
// Phase 12.7 — `myceliate` global command shim.
//
// Invokes the project-local tsx binary so src/index.ts runs directly without
// a build step. Using `node_modules/.bin/tsx` (rather than `node --import
// tsx`) is essential: Node's `--import` resolver uses the spawning cwd, so
// when the user runs `myceliate` from outside the project, `tsx` isn't on
// the resolution path. The tsx bin script self-resolves its loader from the
// project's own node_modules.
//
// Forwards args, signals, and stdio so the Ink TUI gets a real TTY (Tab
// toggle / Ctrl+D / colour rendering all work as if `pnpm dev` were run
// from the project root).
//
// Installed via `pnpm link --global` from the project root or by symlinking
// this file into a directory on PATH (e.g. `ln -sf ... ~/.local/bin/myceliate`).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const entry = join(projectRoot, 'src', 'index.ts');
const tsxBin = join(projectRoot, 'node_modules', '.bin', 'tsx');
const projectTsconfig = join(projectRoot, 'tsconfig.json');

if (!existsSync(tsxBin)) {
  console.error(
    `myceliate: tsx not found at ${tsxBin}\n` +
      `Run \`pnpm install\` in ${projectRoot} to populate node_modules.`,
  );
  process.exit(1);
}

// `--tsconfig` is essential when invoked from outside the project: tsx's
// default tsconfig discovery walks up from cwd, so without it tsx falls back
// to classic JSX runtime and crashes on `import type React from 'react'`
// (the project compiles with `"jsx": "react-jsx"` — automatic runtime).
const child = spawn(tsxBin, ['--tsconfig', projectTsconfig, entry, ...process.argv.slice(2)], {
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
