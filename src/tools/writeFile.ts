// src/tools/writeFile.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Write content to a UTF-8 text file at the given absolute path. Creates parent directories.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  run: async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}`;
  },
};
