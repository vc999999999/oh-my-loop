/**
 * budget —— 从 opencode 事件累加用量 + cache 分价成本。
 *
 * 来源:ralph-loop-agent calculateCost(cache read/write 分价,否则高估几倍)。
 * opencode run 的 cost/tokens 在每个 step_finish 里,无总计 → 累加。
 */

import type { BudgetUsage } from "./schema/state.ts";

/** opencode step_finish.part.tokens 的形状(来自 cortex opencode-adapter 实测)。 */
export type OpenCodeTokens = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type CostRates = {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
};

/** 把一个 step_finish 的用量累加进 usage(原地返回新对象)。 */
export function accumulate(
  usage: BudgetUsage,
  step: { costUsd?: number | null; tokens?: OpenCodeTokens | null },
): BudgetUsage {
  const t = step.tokens ?? {};
  return {
    ...usage,
    inputTokens: usage.inputTokens + (t.input ?? 0),
    outputTokens: usage.outputTokens + (t.output ?? 0),
    cacheReadTokens: usage.cacheReadTokens + (t.cache?.read ?? 0),
    cacheWriteTokens: usage.cacheWriteTokens + (t.cache?.write ?? 0),
    // opencode 直接给了 cost,优先用它;否则留给 calcCost 估算
    costUsd: usage.costUsd + (typeof step.costUsd === "number" ? step.costUsd : 0),
    lastOutputAt: new Date().toISOString(),
  };
}

/**
 * 从累计 token + rates 估成本(当 opencode 没直接给 cost 时用)。
 * 抄 ralph calculateCost:cache read/write 单独计价。
 */
export function calcCost(usage: BudgetUsage, rates: CostRates): number {
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const cacheReadRate = rates.cacheReadCostPerMillion ?? rates.inputCostPerMillion;
  const cacheWriteRate = rates.cacheWriteCostPerMillion ?? rates.inputCostPerMillion;
  const inputCost =
    (uncachedInput / 1_000_000) * rates.inputCostPerMillion +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate;
  const outputCost = (usage.outputTokens / 1_000_000) * rates.outputCostPerMillion;
  return inputCost + outputCost;
}

/** 总 token(input+output)。 */
export function totalTokens(usage: BudgetUsage): number {
  return usage.inputTokens + usage.outputTokens;
}
