// src/tools/listDir.ts
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { filterSecretFiles } from '../security/secretFileFilter.js';
import type { Tool } from './registry.js';

export const listDirTool: Tool<{ path: string }> = {
  name: 'list_dir',
  description: 'List entries in a directory, one per line.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string() }),
  // Phase 16 review (MAJOR-1): filter secret-adjacent filenames from the result.
  // The same filter applies to `senseContext.dirEntries` (system-prompt injection);
  // this closes the parallel R11 leak surface where an execution sub-agent could
  // call `list_dir .` and bypass the system-prompt filter.
  run: async ({ path }) => {
    const entries = await readdir(path);
    return filterSecretFiles(entries).sort().join('\n');
  },
};
