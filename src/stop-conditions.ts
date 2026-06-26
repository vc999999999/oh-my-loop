/**
 * stop-conditions —— 可组合停止 predicate(一等公民)。
 *
 * 来源:ralph-loop-agent(可组合 predicate,isRalphStopConditionMet 取 .some())
 *   + goal-plugin(noProgress/noToolCall)+ Ralph Wiggum(sameError)+ cortex(dead-man)。
 *
 * 预算守卫 = always-on 的 shouldStop,在 triage 入口 + 每轮 execute 前跑。
 * 任一命中即停(OR),命中返回 reason → 控制器 escalate。
 */

import type { BudgetUsage, BudgetLimits } from "./schema/state.ts";
import { totalTokens } from "./budget.ts";

export type StopContext = {
  iteration: number;
  usage: BudgetUsage;
  limits: BudgetLimits;
  now: number; // Date.now()
  /** 最近若干轮的错误指纹(归一化后 hash)。 */
  recentErrorFingerprints: string[];
  /** 最近若干轮的进度指纹。连续相同 = 无进展。 */
  recentProgressFingerprints: string[];
  /** 最近若干轮每轮的工具调用次数。 */
  recentToolCallCounts: number[];
};

export type StopPredicate = {
  name: string;
  hit: (ctx: StopContext) => boolean;
};

// ── 资源类(抄 ralph,补墙钟/dead-man)──────────────────────────────

export const iterationCountIs: StopPredicate = {
  name: "iteration",
  hit: (c) => c.limits.maxIterations != null && c.iteration >= c.limits.maxIterations,
};

export const tokenCountIs: StopPredicate = {
  name: "token",
  hit: (c) => c.limits.maxTokens != null && totalTokens(c.usage) >= c.limits.maxTokens,
};

export const costIs: StopPredicate = {
  name: "cost",
  hit: (c) => c.limits.maxCostUsd != null && c.usage.costUsd >= c.limits.maxCostUsd - c.limits.reserveUsd,
};

export const wallClockExceeds: StopPredicate = {
  name: "wallclock",
  hit: (c) => {
    if (c.limits.maxWallClockMs == null) return false;
    return c.now - Date.parse(c.usage.startedAt) >= c.limits.maxWallClockMs;
  },
};

export const deadManTimeout: StopPredicate = {
  name: "deadman",
  hit: (c) => {
    if (!c.usage.lastOutputAt) return false;
    return c.now - Date.parse(c.usage.lastOutputAt) >= c.limits.deadManMs;
  },
};

// ── 进展类(新增:goal-plugin + Ralph Wiggum)──────────────────────

export const sameErrorRepeats: StopPredicate = {
  name: "same_error",
  hit: (c) => {
    const n = c.limits.sameErrorRepeatLimit;
    const tail = c.recentErrorFingerprints.slice(-n);
    return tail.length >= n && tail.every((f) => f && f === tail[0]);
  },
};

export const noProgressFor: StopPredicate = {
  name: "no_progress",
  hit: (c) => {
    const n = c.limits.noProgressIterations;
    const tail = c.recentProgressFingerprints.slice(-n);
    return tail.length >= n && tail.every((f) => f === tail[0]);
  },
};

export const noToolCallFor: StopPredicate = {
  name: "no_tool_call",
  hit: (c) => {
    const n = c.limits.noToolCallIterations;
    const tail = c.recentToolCallCounts.slice(-n);
    return tail.length >= n && tail.every((x) => x === 0);
  },
};

/** Phase 0 默认 predicate 集合(daily-triage,L1)。 */
export const defaultPredicates: StopPredicate[] = [
  iterationCountIs,
  tokenCountIs,
  costIs,
  wallClockExceeds,
  deadManTimeout,
  sameErrorRepeats,
  noProgressFor,
  noToolCallFor,
];

/** 任一命中即停(OR 短路)。命中返回 {stop:true, reason}。抄 ralph .some()。 */
export function shouldStop(
  preds: StopPredicate[],
  ctx: StopContext,
): { stop: boolean; reason?: string } {
  for (const p of preds) {
    if (p.hit(ctx)) return { stop: true, reason: p.name };
  }
  return { stop: false };
}
