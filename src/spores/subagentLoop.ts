import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { Message } from '../adapters/messages.js';
import { roleToModel } from '../runtime/roleToModel.js';
import { HitlGate } from '../security/hitlGate.js';
import { grepTool } from '../tools/grep.js';
import { listDirTool } from '../tools/listDir.js';
import { createReadFileTool } from '../tools/readFile.js';
import { ToolRegistry } from '../tools/registry.js';
import { createWriteFileTool } from '../tools/writeFile.js';
import type { Logger } from '../util/logger.js';

/**
 * v1.5 Cortina: subagents run in subprocesses with no UI for HITL prompts.
 * They get a HitlGate variant that auto-rejects any operation that would
 * normally require approval (writes outside cwd, reads of sensitive paths).
 * The subagent receives the rejection as a tool error and either retries
 * with a cwd-relative path or surfaces the limitation back to the orchestrator.
 *
 * Symmetric security posture vs orchestrator without requiring IPC for HITL.
 */
function buildSubagentHitl(): HitlGate {
  return new HitlGate({
    requestApproval: async (req) => ({
      decision: 'reject',
      feedback: `subagent cannot prompt for approval (no UI). ${req.reason}. Restructure to use a cwd-relative path or escalate to the orchestrator.`,
    }),
  });
}

/**
 * Build a sub-agent-scoped ToolRegistry containing only execution tools (R9).
 * No coordination tools (spawn_subagent, germinate_spore) are registered here.
 */
function buildSubagentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const hitl = buildSubagentHitl();
  registry.register(createReadFileTool({ hitl }));
  registry.register(listDirTool);
  registry.register(grepTool);
  registry.register(createWriteFileTool({ hitl }));
  // Note: bash is NOT registered for sub-agents in v1 — sub-agents can read/write
  // files and grep, but cannot execute arbitrary shell commands. Extend in v1.3+.
  return registry;
}

export interface SubagentLoopArgs {
  client: DeepSeekClient;
  personaSkill: string;
  task: string;
  maxSteps: number;
  /**
   * Phase 2 closure: per-step `request_started` log line so smoke-test
   * walk-point 9 can literally verify "subagent dispatches always log Flash".
   * Optional to keep the loop testable without a logger fixture.
   */
  logger?: Logger;
}

export async function runSubagentLoop(args: SubagentLoopArgs): Promise<string> {
  const { client, personaSkill, task, maxSteps, logger } = args;
  const registry = buildSubagentRegistry();
  const tools = registry.definitions();
  const subagentModel = roleToModel('subagent');
  const messages: Message[] = [
    { role: 'system', content: personaSkill },
    { role: 'user', content: task },
  ];
  let step = 0;
  let final = '';
  while (step < maxSteps) {
    let assistantText = '';
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    logger?.info({ event: 'request_started', role: 'subagent', model: subagentModel, step });
    for await (const event of client.stream({
      model: subagentModel,
      messages,
      tools,
      thinking: false,
      strict: true,
    })) {
      if ('type' in event) {
        if (event.type === 'content_delta') assistantText += event.text;
        if (event.type === 'tool_call')
          toolCalls.push({ id: event.id, name: event.name, args: event.args });
      }
    }
    messages.push({ role: 'assistant', content: assistantText });
    if (toolCalls.length === 0) {
      final = assistantText;
      break;
    }
    for (const call of toolCalls) {
      let resultContent: string;
      let toolErrored = false;
      try {
        resultContent = await registry.invoke(call.name, call.args, {
          cwd: process.cwd(),
          abort: new AbortController().signal,
          toolUseId: call.id,
        });
      } catch (err) {
        resultContent = err instanceof Error ? err.message : String(err);
        toolErrored = true;
      }
      messages.push({
        role: 'tool',
        result: {
          tool_use_id: call.id,
          command: call.name,
          is_error: toolErrored,
          content: resultContent,
        },
      });
    }
    step += 1;
  }
  return final || '(no final answer — loop hit max steps)';
}
