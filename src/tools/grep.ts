// src/tools/grep.ts
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const grepTool: Tool<{ pattern: string; path: string }> = {
  name: 'grep',
  description:
    'Search files recursively under path for lines matching a regex. Returns path:lineNo:text per match.',
  capability: 'execution',
  inputSchema: { kind: 'zod', zod: z.object({ pattern: z.string(), path: z.string() }) },
  run: async ({ pattern, path }) => {
    const re = new RegExp(pattern);
    const matches: string[] = [];
    await walk(path, async (filePath, relPath) => {
      const content = await readFile(filePath, 'utf8');
      content.split('\n').forEach((line, i) => {
        if (re.test(line)) matches.push(`${relPath}:${i + 1}:${line}`);
      });
    });
    return matches.join('\n');
  },
};

async function walk(
  root: string,
  visit: (filePath: string, relPath: string) => Promise<void>,
): Promise<void> {
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  while (queue.length > 0) {
    // Safe destructuring — avoids noUncheckedIndexedAccess / non-null assertion (lesson #3)
    const next = queue.shift();
    if (!next) break;
    const { abs, rel } = next;
    // lstat (not stat) so symlinks don't dereference — circular links would otherwise hang the walk.
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      // Skip — sandboxing/traversal policy lives at the security gateway (R11), not here.
      continue;
    }
    if (st.isFile()) {
      // Use path.relative for cross-platform correctness; fall back to basename when abs === root
      const rawRel = rel !== '' ? rel : relative(root, abs);
      const relPath = rawRel !== '' ? rawRel : basename(abs);
      await visit(abs, relPath);
    } else if (st.isDirectory()) {
      const entries = await readdir(abs);
      for (const name of entries) {
        queue.push({ abs: join(abs, name), rel: rel !== '' ? join(rel, name) : name });
      }
    }
  }
}
