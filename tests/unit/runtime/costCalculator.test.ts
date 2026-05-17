import { describe, expect, it } from 'vitest';
import {
  PRICING,
  calculateCost,
  formatCostUSD,
  toUsageStats,
} from '../../../src/runtime/costCalculator.js';

describe('PRICING', () => {
  it('contains all three known models', () => {
    expect(PRICING['deepseek-v4-pro']).toBeDefined();
    expect(PRICING['deepseek-v4-flash']).toBeDefined();
    expect(PRICING['deepseek-reasoner']).toBeDefined();
  });
});

describe('calculateCost', () => {
  it('computes Pro pricing for 1k in + 1k out', () => {
    const result = calculateCost('deepseek-v4-pro', {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(result.inputCost).toBeCloseTo(0.00027, 8);
    expect(result.outputCost).toBeCloseTo(0.0011, 8);
    expect(result.cacheHitCost).toBe(0);
    expect(result.totalCost).toBeCloseTo(0.00137, 8);
    expect(result.model).toBe('deepseek-v4-pro');
  });

  it('computes Flash pricing for 10k in + 5k out', () => {
    const result = calculateCost('deepseek-v4-flash', {
      inputTokens: 10000,
      outputTokens: 5000,
    });
    expect(result.inputCost).toBeCloseTo(0.00014, 8);
    expect(result.outputCost).toBeCloseTo(0.0014, 8);
    expect(result.totalCost).toBeCloseTo(0.00154, 8);
  });

  it('applies cache-hit discount (cached tokens billed at cacheHitPerM, deducted from input)', () => {
    const result = calculateCost('deepseek-v4-pro', {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 400,
    });
    // 600 uncached @ 0.27/M = 0.000162
    // 400 cached @ 0.07/M = 0.000028
    // total input billed = 0.000190
    expect(result.inputCost).toBeCloseTo(0.000162, 8);
    expect(result.cacheHitCost).toBeCloseTo(0.000028, 8);
    expect(result.totalCost).toBeCloseTo(0.00019, 8);
  });

  it('returns zero-cost breakdown for unknown model with warn semantics', () => {
    const result = calculateCost('ollama:llama3', {
      inputTokens: 5000,
      outputTokens: 2000,
    });
    expect(result.totalCost).toBe(0);
    expect(result.inputCost).toBe(0);
    expect(result.outputCost).toBe(0);
    expect(result.model).toBe('ollama:llama3');
  });

  it('handles zero-token usage cleanly', () => {
    const result = calculateCost('deepseek-v4-pro', {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result.totalCost).toBe(0);
  });
});

describe('toUsageStats', () => {
  it('maps all three fields correctly when cacheHitTokens is defined', () => {
    const result = toUsageStats({ promptTokens: 100, completionTokens: 50, cacheHitTokens: 20 });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cachedInputTokens).toBe(20);
  });

  it('omits cachedInputTokens when cacheHitTokens is undefined', () => {
    const result = toUsageStats({ promptTokens: 80, completionTokens: 30 });
    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(30);
    expect('cachedInputTokens' in result).toBe(false);
  });

  it('includes cachedInputTokens: 0 when cacheHitTokens is 0 (zero is not absence)', () => {
    const result = toUsageStats({ promptTokens: 60, completionTokens: 20, cacheHitTokens: 0 });
    expect(result.inputTokens).toBe(60);
    expect(result.outputTokens).toBe(20);
    expect('cachedInputTokens' in result).toBe(true);
    expect(result.cachedInputTokens).toBe(0);
  });
});

describe('formatCostUSD', () => {
  it('default 4 decimal places for per-turn precision', () => {
    expect(formatCostUSD(0.00137)).toBe('$0.0014');
    expect(formatCostUSD(0.000123)).toBe('$0.0001');
  });

  it('2 decimal places for session totals', () => {
    expect(formatCostUSD(0.1234, 2)).toBe('$0.12');
    expect(formatCostUSD(5.4321, 2)).toBe('$5.43');
  });

  it('handles zero cleanly', () => {
    expect(formatCostUSD(0)).toBe('$0.0000');
    expect(formatCostUSD(0, 2)).toBe('$0.00');
  });
});
