// tests/unit/compaction/budgetChecker.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { BudgetChecker } from '../../../src/orchestrator/compaction/budgetChecker.js';

const big = (n: number): Message => ({ role: 'user', content: 'x'.repeat(n) });

describe('BudgetChecker', () => {
  it('reports under-budget when below threshold', () => {
    const c = new BudgetChecker({
      workingBudget: 1000,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    const verdict = c.check([big(100)]);
    expect(verdict.action).toBe('none');
  });

  it('triggers prune at >= prune threshold', () => {
    const c = new BudgetChecker({
      workingBudget: 100,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    expect(c.check([big(320)]).action).toBe('prune');
  });

  it('escalates to snip then micro then refuse', () => {
    const c = new BudgetChecker({
      workingBudget: 100,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    expect(c.check([big(340)]).action).toBe('snip');
    expect(c.check([big(360)]).action).toBe('micro');
    expect(c.check([big(400)]).action).toBe('refuse');
  });

  // Extra cases beyond the plan

  it('exactly at prune threshold triggers prune (boundary)', () => {
    // workingBudget=100 means 80 tokens triggers prune
    // big(316) => content 'x'.repeat(316) => estimateTokens = ceil(316/4) = 79 tokens + 4 overhead = 83 => ~83% => prune
    // We need exactly 80 tokens of content: ceil(chars/4)=80 => chars=320 (already boundary)
    // user msg: estimateTokens(content) + 4 = ceil(320/4) + 4 = 80 + 4 = 84 => 84% => prune
    // To hit exactly 80 pct: need used=80, so content tokens=76, chars=304 (ceil(304/4)=76, +4=80)
    const c = new BudgetChecker({
      workingBudget: 100,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    // used = ceil(304/4) + 4 = 76 + 4 = 80, pct = 80.0 >= 80 => prune
    expect(c.check([big(304)]).action).toBe('prune');
  });

  it('pct returned matches (used / workingBudget) * 100', () => {
    const c = new BudgetChecker({
      workingBudget: 1000,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    const verdict = c.check([big(400)]);
    // estimateTokens('x'.repeat(400)) + 4 = 100 + 4 = 104 tokens
    expect(verdict.used).toBe(104);
    expect(verdict.pct).toBe((104 / 1000) * 100);
  });

  it('verdict.used matches total estimated tokens', () => {
    const c = new BudgetChecker({
      workingBudget: 10000,
      pruneThresholdPct: 80,
      snipThresholdPct: 85,
      microThresholdPct: 90,
      refusalThresholdPct: 95,
    });
    const msgs: Message[] = [
      { role: 'user', content: 'abcdefgh' }, // ceil(8/4)+4 = 2+4 = 6
      { role: 'system', content: 'sys' }, // ceil(3/4)+4 = 1+4 = 5
    ];
    const verdict = c.check(msgs);
    expect(verdict.used).toBe(11);
  });

  it('rejects misconfigured threshold ladder (prune > snip)', () => {
    expect(
      () =>
        new BudgetChecker({
          workingBudget: 1000,
          pruneThresholdPct: 90, // higher than snip — invalid
          snipThresholdPct: 80,
          microThresholdPct: 92,
          refusalThresholdPct: 95,
        }),
    ).toThrow(/non-decreasing/i);
  });

  it('rejects misconfigured threshold ladder (micro > refusal)', () => {
    expect(
      () =>
        new BudgetChecker({
          workingBudget: 1000,
          pruneThresholdPct: 80,
          snipThresholdPct: 85,
          microThresholdPct: 99, // higher than refusal — invalid
          refusalThresholdPct: 95,
        }),
    ).toThrow(/non-decreasing/i);
  });

  it('accepts equal adjacent thresholds (non-decreasing, not strictly increasing)', () => {
    expect(
      () =>
        new BudgetChecker({
          workingBudget: 1000,
          pruneThresholdPct: 80,
          snipThresholdPct: 80,
          microThresholdPct: 80,
          refusalThresholdPct: 95,
        }),
    ).not.toThrow();
  });
});
