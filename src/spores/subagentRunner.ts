// Standalone entry point. Run via:
//   node dist/spores/subagentRunner.js   (production)
//   tsx src/spores/subagentRunner.ts     (dev)
//
// Reads a JSON request from stdin: { persona_name, persona_skill, task }
// Writes a JSON response to stdout: { ok, summary | error, stderr_tail? }
//
// Has no orchestrator runtime imports — only the adapters + execution-tool registry.
// Per R8: stateless, ephemeral, communicates via JSON on stdin/stdout.
import { exit, stdin, stdout } from 'node:process';
import { z } from 'zod';
import { createDeepSeekClient } from '../adapters/index.js';
import { runSubagentLoop } from './subagentLoop.js';

const RequestSchema = z
  .object({
    persona_name: z.string(),
    persona_skill: z.string(),
    task: z.string(),
  })
  .strict();

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  try {
    const raw = await readAll(stdin);
    const req = RequestSchema.parse(JSON.parse(raw));
    const client = createDeepSeekClient();
    const summary = await runSubagentLoop({
      client,
      personaSkill: req.persona_skill,
      task: req.task,
      maxSteps: 20,
    });
    stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
    exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    exit(1);
  }
}

void main();
