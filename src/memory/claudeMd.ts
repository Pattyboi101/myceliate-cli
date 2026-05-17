// src/memory/claudeMd.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load the CLAUDE.md project rules from `cwd`.
 * Returns the file contents verbatim (no trimming, no parsing) so callers
 * can inject it as a system prompt without loss of formatting.
 * Returns an empty string when the file is absent.
 */
export async function loadProjectClaudeMd(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
  } catch {
    return '';
  }
}
