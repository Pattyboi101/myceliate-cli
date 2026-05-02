// src/tools/listDir.ts
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const listDirTool: Tool<{ path: string }> = {
  name: 'list_dir',
  description: 'List entries in a directory, one per line.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string() }),
  run: async ({ path }) => {
    const entries = await readdir(path);
    return entries.sort().join('\n');
  },
};
