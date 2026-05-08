import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { Message } from '../adapters/messages.js';
import { grepTool } from '../tools/grep.js';
import { listDirTool } from '../tools/listDir.js';
import { readFileTool } from '../tools/readFile.js';
import { ToolRegistry } from '../tools/registry.js';
import { writeFileTool } from '../tools/writeFile.js';

/**
 * Build a sub-agent-scoped ToolRegistry containing only execution tools (R9).
 * No coordination tools (spawn_subagent, germinate_spore) are registered here.
 */
function buildSubagentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(grepTool);
  registry.register(writeFileTool);
  // Note: bash is NOT registered for sub-agents in v1 — sub-agents can read/write
  // files and grep, but cannot execute arbitrary shell commands. Extend in v1.3+.
  return registry;
}

export interface SubagentLoopArgs {
  client: DeepSeekClient;
  personaSkill: string;
  task: string;
  maxSteps: number;
}

export async function runSubagentLoop(args: SubagentLoopArgs): Promise<string> {
  const { client, personaSkill, task, maxSteps } = args;
  const registry = buildSubagentRegistry();
  const tools = registry.definitions();
  const messages: Message[] = [
    { role: 'system', content: personaSkill },
    { role: 'user', content: task },
  ];
  let step = 0;
  let final = '';
  while (step < maxSteps) {
    let assistantText = '';
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    for await (const event of client.stream({
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-reasoner',
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
      // TODO(v1.4): rename to avoid shadowing isError import from streamEvent.ts
      let isError = false;
      try {
        resultContent = await registry.invoke(call.name, call.args, {
          cwd: process.cwd(),
          abort: new AbortController().signal,
          toolUseId: call.id,
        });
      } catch (err) {
        resultContent = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      messages.push({
        role: 'tool',
        result: {
          tool_use_id: call.id,
          command: call.name,
          is_error: isError,
          content: resultContent,
        },
      });
    }
    step += 1;
  }
  return final || '(no final answer — loop hit max steps)';
}
