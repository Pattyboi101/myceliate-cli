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
  /** Phase 23: when true, ToolRegistry.invoke skips the allowlist gate.
   * Reserved for ConversationLog rehydration during --resume. NEVER set
   * from a live runReactLoop turn — secure default is gated. */
  isHistoricalReplay?: boolean;
};

/** Phase 23: thrown when invoke() is called for a tool not visible to the active
 * spore's allowlist on a live (non-rehydration) turn. The ReAct loop catches
 * this and surfaces a tool error result so the model can recover. Carries
 * `cause` per CLAUDE.md "errors are typed and carry cause" convention,
 * mirroring SkillFrontmatterError — currently unused (denial is a pure
 * predicate result, not a wrapped exception) but preserved for future
 * call sites that want to chain context. */
export class ToolDeniedByAllowlistError extends Error {
  constructor(
    public readonly toolName: string,
    override readonly cause?: unknown,
  ) {
    super(`Tool execution denied by active spore allowlist: ${toolName}`);
    this.name = 'ToolDeniedByAllowlistError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();
  private activeAllowlist: string[] | null = null;

  register<I>(tool: Tool<I>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  setActiveAllowlist(names: string[] | null): void {
    this.activeAllowlist = names;
  }

  /** Single source of truth for the allowlist predicate — backs both the
   * schema-layer filter (getActiveTools/definitions) AND the dispatch-layer
   * gate (invoke). Coordination tools are always allowed; execution tools are
   * gated on the active allowlist when one is set. The two layers MUST NOT
   * drift. */
  private isToolAllowed(tool: Tool<unknown>): boolean {
    if (this.activeAllowlist === null) return true;
    if (tool.capability === 'coordination') return true;
    return this.activeAllowlist.includes(tool.name);
  }

  getActiveTools(): Tool<unknown>[] {
    return [...this.tools.values()].filter((t) => this.isToolAllowed(t));
  }

  definitions(): ToolDefinition[] {
    return this.getActiveTools().map((t) => ({
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
    // Phase 23 dispatch-layer gate. Defense-in-depth: even if the schema-layer
    // filter is bypassed (model hallucination, future bypass code path), this
    // gate prevents execution. The ctx.isHistoricalReplay bypass is reserved
    // for future rehydration paths that re-execute historical tool_calls;
    // v1.4 --resume only reconstructs message history (no invoke), so no
    // production caller currently sets the flag. The integration test in
    // toolRestrictionResume validates the bypass works at the registry level.
    if (!ctx?.isHistoricalReplay && !this.isToolAllowed(tool)) {
      throw new ToolDeniedByAllowlistError(name);
    }
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
