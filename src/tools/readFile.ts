// src/tools/readFile.ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { HitlGate } from '../security/hitlGate.js';
import type { Tool } from './registry.js';

export type ReadFileToolDeps = { hitl: HitlGate };

export function createReadFileTool(deps: ReadFileToolDeps): Tool<{ path: string }> {
  return {
    name: 'read_file',
    description:
      'Read the full contents of a UTF-8 text file at the given absolute path. Reads of sensitive paths (SSH/AWS/GPG/.netrc/shell startup/system accounts) require HITL approval.',
    capability: 'execution',
    inputSchema: z.object({ path: z.string() }),
    run: async ({ path }, ctx) => {
      const verdict = await deps.hitl.checkRead({
        path,
        requestId: ctx.toolUseId,
      });
      if (!verdict.allowed) {
        throw new Error(`HITL rejected: ${verdict.feedback}`);
      }
      return readFile(path, 'utf8');
    },
  };
}
