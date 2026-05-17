export const PRICING = {
  'deepseek-v4-pro': { inputPerM: 0.27, outputPerM: 1.1, cacheHitPerM: 0.07 },
  'deepseek-v4-flash': { inputPerM: 0.014, outputPerM: 0.28, cacheHitPerM: 0.0035 },
  'deepseek-reasoner': { inputPerM: 0.55, outputPerM: 2.19, cacheHitPerM: 0.14 },
} as const;

export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

export type CostBreakdown = {
  model: string;
  inputCost: number;
  outputCost: number;
  cacheHitCost: number;
  totalCost: number;
  /** Raw token counts carried alongside the dollar breakdown so consumers
   * (e.g. TelemetryFooter) can display both without re-deriving from prices. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

const PER_MILLION = 1_000_000;

export function calculateCost(model: string, usage: UsageStats): CostBreakdown {
  const rates = (
    PRICING as Record<string, { inputPerM: number; outputPerM: number; cacheHitPerM: number }>
  )[model];
  const cachedIn = usage.cachedInputTokens ?? 0;
  if (!rates) {
    return {
      model,
      inputCost: 0,
      outputCost: 0,
      cacheHitCost: 0,
      totalCost: 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: cachedIn,
    };
  }
  const uncachedIn = Math.max(0, usage.inputTokens - cachedIn);
  const inputCost = (uncachedIn * rates.inputPerM) / PER_MILLION;
  const outputCost = (usage.outputTokens * rates.outputPerM) / PER_MILLION;
  const cacheHitCost = (cachedIn * rates.cacheHitPerM) / PER_MILLION;
  const totalCost = inputCost + outputCost + cacheHitCost;
  return {
    model,
    inputCost,
    outputCost,
    cacheHitCost,
    totalCost,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: cachedIn,
  };
}

export function formatCostUSD(usd: number, places = 4): string {
  return `$${usd.toFixed(places)}`;
}

/**
 * Map the `done.usage` shape (from DeepSeek stream events) to the `UsageStats`
 * shape expected by `calculateCost`. Extracted to eliminate the duplicated
 * mapping in reactLoop.ts and subagentLoop.ts (DRY fix-pass).
 *
 * `cacheHitTokens` is conditionally spread: when undefined the key is absent
 * from the result (exactOptionalPropertyTypes safe). When 0 the key IS present
 * so callers can distinguish "cache-hit field absent" from "zero cache hits".
 */
export function toUsageStats(u: {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
}): UsageStats {
  return {
    inputTokens: u.promptTokens,
    outputTokens: u.completionTokens,
    ...(u.cacheHitTokens !== undefined ? { cachedInputTokens: u.cacheHitTokens } : {}),
  };
}
