// src/orchestrator/QueryEngine.ts
import type { ChatRequest, ToolDefinition } from '../adapters/DeepSeekClient.js';
import type { AssistantMessage, Message, ToolResult } from '../adapters/messages.js';
import { hasToolCalls } from '../adapters/messages.js';
import { BudgetChecker, type BudgetThresholds } from './compaction/budgetChecker.js';
import { microCompact } from './compaction/microCompactor.js';
import { snipDeadEnds } from './compaction/snipper.js';
import { pruneToolOutputs } from './compaction/toolOutputPruner.js';

export type QueryEngineOptions = {
  systemPrompt: string;
  workingBudget: number;
  thresholds?: Partial<Omit<BudgetThresholds, 'workingBudget'>>;
  protectedTailMessages?: number;
  protectedTailTokens?: number;
  maxToolOutputChars?: number;
  /** Phase 18: rehydrate from a prior session's saved history. Pushed onto
   * the private history array verbatim — no validation here; the caller
   * (src/index.ts --resume path) is responsible for rejecting sessions
   * that end mid-tool-call via isSafeToResume(). */
  initialHistory?: readonly Message[];
};

const DEFAULT_THRESHOLDS = {
  pruneThresholdPct: 80,
  snipThresholdPct: 85,
  microThresholdPct: 90,
  refusalThresholdPct: 95,
};

export type CompactionRefusal = Error & { kind: 'compaction_refused' };

export class QueryEngine {
  private readonly history: Message[] = [];
  private readonly checker: BudgetChecker;
  private systemSections: string[];
  private readonly opts: Required<Omit<QueryEngineOptions, 'thresholds' | 'initialHistory'>> & {
    thresholds: BudgetThresholds;
  };

  constructor(opts: QueryEngineOptions) {
    const thresholds: BudgetThresholds = {
      workingBudget: opts.workingBudget,
      ...DEFAULT_THRESHOLDS,
      ...opts.thresholds,
    };
    this.opts = {
      systemPrompt: opts.systemPrompt,
      workingBudget: opts.workingBudget,
      protectedTailMessages: opts.protectedTailMessages ?? 6,
      protectedTailTokens: opts.protectedTailTokens ?? 40_000,
      maxToolOutputChars: opts.maxToolOutputChars ?? 80_000,
      thresholds,
    };
    this.systemSections = [opts.systemPrompt];
    this.checker = new BudgetChecker(thresholds);
    if (opts.initialHistory) {
      for (const m of opts.initialHistory) this.history.push(m);
    }
  }

  /** Append a section to the system prompt. New sections show up in the next prepareRequest call. */
  appendSystemSection(section: string): void {
    this.systemSections.push(section);
  }

  appendUser(content: string): void {
    this.history.push({ role: 'user', content });
  }

  appendAssistant(msg: Omit<AssistantMessage, 'role'>): void {
    this.history.push({ role: 'assistant', ...msg });
  }

  appendToolResult(result: ToolResult): void {
    this.history.push({ role: 'tool', result });
  }

  /** R2: drop reasoning_content from assistant messages without tool_calls. */
  private applyR2(history: readonly Message[]): Message[] {
    return history.map((m) => {
      if (m.role === 'assistant' && !hasToolCalls(m) && m.reasoning_content) {
        // Branch is entered only when !hasToolCalls(m), so we deliberately do NOT
        // copy tool_calls — propagating an empty/missing array would produce an
        // invalid wire shape for both V3 and V4 adapters.
        return { role: 'assistant', content: m.content };
      }
      return m;
    });
  }

  prepareRequest(args: {
    model: string;
    tools: readonly ToolDefinition[];
    thinking: boolean;
    strict: boolean;
    signal?: AbortSignal;
    options?: Readonly<Record<string, unknown>>;
  }): ChatRequest {
    let working: Message[] = [...this.history];
    const verdict = this.checker.check(working);

    // R10: any non-'none' verdict (including 'refuse') runs layers 1–3 in
    // order. Refusing without trying inverts the escalation ladder — a single
    // oversized tool result that lands directly in the 'refuse' band would
    // otherwise be rejected without L1's truncation ever firing. Re-evaluate
    // the budget after compaction; only refuse if usage is *still* >= refusal
    // threshold once layers 1–3 have done their best.
    if (verdict.action !== 'none') {
      working = pruneToolOutputs(working, {
        maxToolOutputChars: this.opts.maxToolOutputChars,
        protectedTailMessages: this.opts.protectedTailMessages,
      });
      working = snipDeadEnds(working, { protectedTailTokens: this.opts.protectedTailTokens });
      working = microCompact(working, { protectedTailMessages: this.opts.protectedTailMessages });

      const post = this.checker.check(working);
      if (post.action === 'refuse') {
        const err = new Error(
          'compaction_required: working budget exhausted (layers 1-3 insufficient; layers 4-5 deferred to v2)',
        ) as CompactionRefusal;
        err.kind = 'compaction_refused';
        throw err;
      }
    }

    const system: Message = { role: 'system', content: this.systemSections.join('') };
    const messages: Message[] = [system, ...this.applyR2(working)];
    return {
      model: args.model,
      messages,
      tools: args.tools,
      thinking: args.thinking,
      strict: args.strict,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.options ? { options: args.options } : {}),
    };
  }

  snapshot(): readonly Message[] {
    return [...this.history];
  }
}
