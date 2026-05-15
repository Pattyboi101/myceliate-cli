// src/orchestrator/QueryEngine.ts
import type { ChatRequest, ToolDefinition } from '../adapters/DeepSeekClient.js';
import type { AssistantMessage, Message, ToolResult } from '../adapters/messages.js';
import { hasReasoningContent, hasToolCalls } from '../adapters/messages.js';
import { type CavemanState, applyCavemanPrefix } from '../runtime/cavemanMode.js';
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
  // `systemPrompt` lives in `systemSections` (mutable, so runtime germination
  // can append). It's intentionally NOT stored in `opts` to avoid a second
  // copy that would silently diverge.
  private readonly opts: Required<
    Omit<QueryEngineOptions, 'thresholds' | 'initialHistory' | 'systemPrompt'>
  > & {
    thresholds: BudgetThresholds;
  };

  constructor(opts: QueryEngineOptions) {
    const thresholds: BudgetThresholds = {
      workingBudget: opts.workingBudget,
      ...DEFAULT_THRESHOLDS,
      ...opts.thresholds,
    };
    this.opts = {
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

  /**
   * Phase 21 stretch: replace any previously-germinated spore section with a new one.
   *
   * If the model calls `germinate_spore` twice in one session with different spore
   * names, `appendSystemSection` would stack both bodies — the model ends up with two
   * sector contexts. This method drops any section tagged
   * `<!-- BEGIN GERMINATED SPORE: ... -->` before pushing the new one.
   *
   * Falls back to `appendSystemSection` when no germinated section exists yet.
   */
  replaceGerminatedSection(section: string): void {
    const BEGIN = '<!-- BEGIN GERMINATED SPORE:';
    const END_TAG = '<!-- END GERMINATED SPORE:';
    // Drop all sections that contain a BEGIN tag (there should only ever be one,
    // but we clear all to be defensive).
    const filtered = this.systemSections.filter((s) => !s.includes(BEGIN) && !s.includes(END_TAG));
    // Replace in-place to preserve array identity for any external references.
    this.systemSections.length = 0;
    for (const s of filtered) this.systemSections.push(s);
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

  /**
   * True iff any assistant turn in history has both tool_calls and non-empty
   * reasoning_content — i.e., R2 will retain that reasoning_content in the
   * next API request. Used by reactLoop to dispatch repl-with-reasoning.
   *
   * Monotonic during a session: once true, stays true (R2 never drops
   * reasoning from already-tool-call turns). Caller can trust this is a
   * one-way ratchet; no need to debounce.
   */
  hasRetainedReasoning(): boolean {
    return this.history.some((m) => hasToolCalls(m) && hasReasoningContent(m));
  }

  /** R2: drop reasoning_content from assistant messages without tool_calls. */
  private applyR2(history: readonly Message[]): Message[] {
    return history.map((m) => {
      if (m.role === 'assistant' && !hasToolCalls(m) && hasReasoningContent(m)) {
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
    /** Phase 2.5: when provided and active, prepends the caveman system prefix. */
    cavemanState?: CavemanState;
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
    const assembled: Message[] = [system, ...this.applyR2(working)];
    // Phase 2.5: apply caveman prefix after system-prompt assembly so the
    // caveman directive always appears BEFORE the project system prompt.
    const messages =
      args.cavemanState !== undefined
        ? applyCavemanPrefix(assembled, args.cavemanState)
        : assembled;
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
