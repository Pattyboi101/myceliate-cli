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
  private readonly system: Message;
  private readonly opts: Required<Omit<QueryEngineOptions, 'thresholds'>> & {
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
    this.system = { role: 'system', content: opts.systemPrompt };
    this.checker = new BudgetChecker(thresholds);
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
        // Build the output object without reasoning_content (no any, no mutation).
        const copy: AssistantMessage = { role: 'assistant', content: m.content };
        if (m.tool_calls) copy.tool_calls = m.tool_calls;
        return copy;
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
    if (verdict.action === 'prune' || verdict.action === 'snip' || verdict.action === 'micro') {
      working = pruneToolOutputs(working, {
        maxToolOutputChars: this.opts.maxToolOutputChars,
        protectedTailMessages: this.opts.protectedTailMessages,
      });
    }
    if (verdict.action === 'snip' || verdict.action === 'micro') {
      working = snipDeadEnds(working, { protectedTailTokens: this.opts.protectedTailTokens });
    }
    if (verdict.action === 'micro') {
      working = microCompact(working, { protectedTailMessages: this.opts.protectedTailMessages });
    }
    if (verdict.action === 'refuse') {
      const err = new Error(
        'compaction_required: working budget exhausted (layers 1-3 insufficient; layers 4-5 deferred to v2)',
      ) as CompactionRefusal;
      err.kind = 'compaction_refused';
      throw err;
    }
    const messages: Message[] = [this.system, ...this.applyR2(working)];
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
