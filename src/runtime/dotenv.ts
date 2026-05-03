// src/runtime/dotenv.ts
import { config } from 'dotenv';

/**
 * Loads `.env` from cwd (or an explicit directory path) if present. Shell-set
 * values win — `override: false` means a key already in `process.env` is
 * preserved, so onboarding env-var defaults still take precedence over file
 * values when explicitly exported.
 *
 * The optional `dir` parameter exists for testability: tests pass a temp dir
 * instead of using `process.chdir()`, which is unsupported in Vitest thread
 * workers.
 */
export function loadDotenv(dir?: string): void {
  config({ path: dir ? `${dir}/.env` : '.env', override: false });
}
