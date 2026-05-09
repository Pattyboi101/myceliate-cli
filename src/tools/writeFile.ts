// src/tools/writeFile.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { HitlGate } from '../security/hitlGate.js';
import type { Tool } from './registry.js';

export type WriteFileToolDeps = { hitl: HitlGate };

export function createWriteFileTool(
  deps: WriteFileToolDeps,
): Tool<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description:
      'Write content to a UTF-8 text file at the given absolute path. Creates parent directories. Writes outside the orchestrator cwd require HITL approval.',
    capability: 'execution',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    run: async ({ path, content }, ctx) => {
      const verdict = await deps.hitl.checkWrite({
        path,
        cwd: ctx.cwd,
        requestId: ctx.toolUseId,
      });
      if (!verdict.allowed) {
        // Cross-module string contract: src/orchestrator/reactLoop.ts catch block detects
        // the 'HITL rejected:' prefix to yield tool_result.status='rejected' instead of 'failed'.
        throw new Error(`HITL rejected: ${verdict.feedback}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}`;
    },
  };
}
