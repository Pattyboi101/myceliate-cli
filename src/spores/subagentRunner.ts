// Standalone entry point. Run via:
//   node dist/spores/subagentRunner.js   (production)
//   tsx src/spores/subagentRunner.ts     (dev)
//
// Reads a JSON request from stdin: { persona_name, persona_skill, task }
// Writes a JSON response to stdout: { ok, summary | error, stderr_tail? }
//
// Has no orchestrator runtime imports — only the adapters + execution-tool registry.
// Per R8: stateless, ephemeral, communicates via JSON on stdin/stdout.
import { join } from 'node:path';
import { cwd, exit, stdin, stdout } from 'node:process';
import { z } from 'zod';
import { createDeepSeekClient } from '../adapters/index.js';
import { createLogger } from '../util/logger.js';
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
  // TODO(v1.4): replace cast with Buffer.isBuffer guard
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // Subagent inherits the orchestrator's cwd, so writing to `.myceliate/logs`
  // relative to cwd lands in the same session.log file the orchestrator uses.
  // POSIX O_APPEND guarantees per-line atomicity for writes <= PIPE_BUF, so
  // concurrent appends from the orchestrator + subagent process are safe.
  // Phase 2 closure: required for walk-point 9 to literally verify
  // "subagent dispatches always log Flash" (criterion 1).
  const logger = createLogger({ logsDir: join(cwd(), '.myceliate', 'logs') });
  try {
    const raw = await readAll(stdin);
    const req = RequestSchema.parse(JSON.parse(raw));
    const client = createDeepSeekClient();
    const summary = await runSubagentLoop({
      client,
      personaSkill: req.persona_skill,
      task: req.task,
      maxSteps: 20,
      logger,
    });
    await logger.flush();
    stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
    exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logger.flush();
    stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    exit(1);
  }
}

void main();
