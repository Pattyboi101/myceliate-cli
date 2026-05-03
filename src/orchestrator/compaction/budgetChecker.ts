// src/orchestrator/compaction/budgetChecker.ts
import type { Message } from '../../adapters/messages.js';
import { estimateHistoryTokens } from '../../util/tokens.js';

export type BudgetThresholds = {
  workingBudget: number;
  pruneThresholdPct: number;
  snipThresholdPct: number;
  microThresholdPct: number;
  refusalThresholdPct: number;
};

export type BudgetVerdict = {
  used: number;
  pct: number;
  action: 'none' | 'prune' | 'snip' | 'micro' | 'refuse';
};

export class BudgetChecker {
  constructor(private readonly t: BudgetThresholds) {}

  check(history: readonly Message[]): BudgetVerdict {
    const used = estimateHistoryTokens(history);
    const pct = (used / this.t.workingBudget) * 100;
    let action: BudgetVerdict['action'] = 'none';
    if (pct >= this.t.refusalThresholdPct) action = 'refuse';
    else if (pct >= this.t.microThresholdPct) action = 'micro';
    else if (pct >= this.t.snipThresholdPct) action = 'snip';
    else if (pct >= this.t.pruneThresholdPct) action = 'prune';
    return { used, pct, action };
  }
}
