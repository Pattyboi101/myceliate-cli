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
};

const PER_MILLION = 1_000_000;

export function calculateCost(model: string, usage: UsageStats): CostBreakdown {
  const rates = (
    PRICING as Record<string, { inputPerM: number; outputPerM: number; cacheHitPerM: number }>
  )[model];
  if (!rates) {
    return { model, inputCost: 0, outputCost: 0, cacheHitCost: 0, totalCost: 0 };
  }
  const cachedIn = usage.cachedInputTokens ?? 0;
  const uncachedIn = Math.max(0, usage.inputTokens - cachedIn);
  const inputCost = (uncachedIn * rates.inputPerM) / PER_MILLION;
  const outputCost = (usage.outputTokens * rates.outputPerM) / PER_MILLION;
  const cacheHitCost = (cachedIn * rates.cacheHitPerM) / PER_MILLION;
  const totalCost = inputCost + outputCost + cacheHitCost;
  return { model, inputCost, outputCost, cacheHitCost, totalCost };
}

export function formatCostUSD(usd: number, places = 4): string {
  return `$${usd.toFixed(places)}`;
}
