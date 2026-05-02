// src/tools/readFile.ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const readFileTool: Tool<{ path: string }> = {
  name: 'read_file',
  description: 'Read the full contents of a UTF-8 text file at the given absolute path.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string() }),
  run: async ({ path }) => readFile(path, 'utf8'),
};
