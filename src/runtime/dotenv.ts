// src/runtime/dotenv.ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Loads `.env` files in priority order:
 *   1. `dir`/.env (when passed) OR cwd/.env — per-project overrides win.
 *   2. Install-root /.env — the project repo's own .env, used as fallback so
 *      `myceliate` invoked from any cwd still picks up DEEPSEEK_API_KEY.
 *
 * `override: false` means a key already in `process.env` is preserved across
 * all loads; shell-set values still win, then primary `.env`, then install
 * root. The optional `dir` parameter exists for testability — tests pass a
 * temp dir instead of using `process.chdir()`, which is unsupported in
 * Vitest thread workers.
 */
export function loadDotenv(dir?: string): void {
  // Primary: explicit dir or cwd.
  config({ path: dir ? join(dir, '.env') : '.env', override: false });
  // Fallback: install-root .env. Resolved relative to this module's location
  // (`src/runtime/dotenv.ts` → install root is two levels up). Wrapped in
  // try/catch so any resolution failure (eg. snapshot/bundled environments)
  // doesn't break startup.
  try {
    const installRoot = fileURLToPath(new URL('../..', import.meta.url));
    config({ path: join(installRoot, '.env'), override: false });
  } catch {
    // ignore — primary load is enough for normal cwd-based development
  }
}
