import type { z } from 'zod';
import type { ToolDefinition } from '../adapters/DeepSeekClient.js';
import { zodToStrictJsonSchema } from './schema.js';

export type Capability = 'coordination' | 'execution';

export type Tool<Input> = {
  name: string;
  description: string;
  capability: Capability;
  inputSchema: z.ZodType<Input>;
  run: (input: Input, ctx: ToolRunContext) => Promise<string>;
};

export type ToolRunContext = {
  cwd: string;
  abort: AbortSignal;
  /** Originating tool_call.id from the LLM stream. Phase 17 m5 fix: threaded
   * here so HITL-gated tools (bash) can identify which call's approval slot
   * the user is responding to in src/index.ts's Map<requestId, fn>. */
  toolUseId: string;
};

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();

  register<I>(tool: Tool<I>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToStrictJsonSchema(t.inputSchema as unknown as z.ZodTypeAny),
    }));
  }

  byCapability(cap: Capability): Tool<unknown>[] {
    return [...this.tools.values()].filter((t) => t.capability === cap);
  }

  async invoke(name: string, rawInput: unknown, ctx?: Partial<ToolRunContext>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const parsed = tool.inputSchema.parse(rawInput);
    const fullCtx: ToolRunContext = {
      cwd: ctx?.cwd ?? process.cwd(),
      abort: ctx?.abort ?? new AbortController().signal,
      // Phase 17 review m5-related: empty-string fallback is a SAFETY default
      // for tests that construct ctx literals without an ID. Production
      // callers (`runReactLoop`) always pass the LLM-provided `call.id`
      // which is never empty. If a future v1.3+ phase introduces parallel
      // tool dispatch where multiple concurrent invokes could hit this
      // fallback (e.g., a test integration suite), replace `''` with
      // `randomUUID()` — two concurrent requests both hitting the empty
      // string would collide on `Map.set('', resolver)` in the HITL bridge
      // and orphan the first promise (the m5 BLOCKER class of bug we just
      // defused, in miniature).
      toolUseId: ctx?.toolUseId ?? '',
    };
    return tool.run(parsed, fullCtx);
  }
}
