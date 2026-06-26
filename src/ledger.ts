/**
 * ledger —— F1:跨会话预算账本 + 真实信号回灌。
 *
 * 控制器单次 run 的用量已在 state.budget.usage 累计(来自 opencode step_finish 事件)。
 * 账本把**每次 run 的用量**追加进 .loop/budget-ledger.ndjson,得到跨会话累计,
 * 并对累计成本/token 做阈值告警 —— 把「只进不出的监控」闭合回控制反馈。
 *
 * 与 opencode 插件的关系:
 *   - tokenscope(per-model cost)/ otel(step-finish telemetry)是 session 内的信号源。
 *   - 本控制器已直接从 `opencode run --format json` 的 step_finish 拿到 cost/tokens(无需读插件)。
 *   - 若要接入插件导出的聚合数据,实现 readExternalUsage() 读其输出文件即可(见末尾接入点)。
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetUsage } from "./schema/state.ts";

export type LedgerEntry = {
  ts: string;
  goalId: string;
  runOutcome: string; // done / escalated / halted
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type LedgerTotals = {
  runs: number;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type ThresholdConfig = {
  /** 跨会话累计成本告警阈值(USD)。 */
  totalCostUsd?: number;
  /** 跨会话累计 token 告警阈值。 */
  totalTokens?: number;
};

export function createLedger(loopDir: string) {
  const path = join(loopDir, "budget-ledger.ndjson");

  /** 一次 run 结束时追加一条。 */
  function record(goalId: string, runOutcome: string, usage: BudgetUsage): LedgerEntry {
    mkdirSync(loopDir, { recursive: true });
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      goalId,
      runOutcome,
      iterations: usage.iterations,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    };
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  /** 读全部历史。 */
  function entries(): LedgerEntry[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LedgerEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is LedgerEntry => x !== null);
  }

  /** 跨会话累计。 */
  function totals(): LedgerTotals {
    return entries().reduce<LedgerTotals>(
      (acc, e) => ({
        runs: acc.runs + 1,
        iterations: acc.iterations + e.iterations,
        inputTokens: acc.inputTokens + e.inputTokens,
        outputTokens: acc.outputTokens + e.outputTokens,
        costUsd: acc.costUsd + e.costUsd,
      }),
      { runs: 0, iterations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
  }

  /** 阈值告警:返回触发的告警列表(空 = 未超)。 */
  function checkThresholds(th: ThresholdConfig): string[] {
    const t = totals();
    const alerts: string[] = [];
    if (th.totalCostUsd != null && t.costUsd >= th.totalCostUsd) {
      alerts.push(`累计成本 $${t.costUsd.toFixed(4)} ≥ 阈值 $${th.totalCostUsd}`);
    }
    if (th.totalTokens != null && t.inputTokens + t.outputTokens >= th.totalTokens) {
      alerts.push(`累计 token ${t.inputTokens + t.outputTokens} ≥ 阈值 ${th.totalTokens}`);
    }
    return alerts;
  }

  return { record, entries, totals, checkThresholds, path };
}

export type Ledger = ReturnType<typeof createLedger>;

/**
 * 接入点(可选):读 tokenscope / otel 插件导出的聚合用量,叠加进账本。
 * 默认返回 null —— 控制器自带的 step_finish 累计已够用;需要订阅级 quota 时再实现。
 * 例:tokenscope 通常把统计写到某个 JSON;读它并映射成 BudgetUsage 即可。
 */
export function readExternalUsage(_loopDir: string): BudgetUsage | null {
  return null;
}
