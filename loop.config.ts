/**
 * Loop 控制器配置(Phase 0 默认)。
 *
 * Phase 0 = L1 daily-triage:只读扫描目标 repo,写 .loop/STATE.md + journal,
 * 绝不改代码。target 可配置,默认当前工作区。
 */

import type { BudgetLimits } from "./src/schema/state.ts";
import type { GateSpec } from "./src/gates.ts";

export type LoopConfig = {
  /** 要托管/扫描的目标 repo 绝对路径。默认运行控制器时的 cwd。 */
  target: string;
  /** .loop/ 目录位置(状态外化根)。默认 target/.loop。 */
  loopDir: string;
  /** 运行模式。Phase 0 只有 daily-triage。 */
  mode: "daily-triage";
  /** 自治等级配置。Phase 0 固定 L1 只读。 */
  autonomy: {
    level: "L1" | "L2" | "L3";
    allowCodeWrite: boolean;
    integrateAction: "none" | "propose" | "auto";
    /** L3 白名单:只有改动全部落在这些前缀内才自动 integrate。 */
    allowlistPaths?: string[];
  };
  /** 预算上限。任一命中 → escalate(budget)。 */
  budget: Partial<BudgetLimits>;
  /** 跑 opencode run 用的 model(可选,默认用 opencode 配置的默认 model)。 */
  model?: string;
  /** Phase 1+:每个 unit 在隔离 worktree 内干活。Phase 0 daily-triage 为 false。 */
  isolate?: boolean;
  /** Phase 1+:verify cycle 跑的门(命令 + negative control)。 */
  gates?: GateSpec[];
  /** 合并回的基分支(默认当前分支)。 */
  baseBranch?: string;
  /** F1:跨会话累计预算告警阈值(.loop/budget-ledger.ndjson)。 */
  ledgerThreshold?: { totalCostUsd?: number; totalTokens?: number };
};

const target = process.env.LOOP_TARGET ?? process.cwd();

export const defaultConfig: LoopConfig = {
  target,
  loopDir: `${target}/.loop`,
  mode: "daily-triage",
  autonomy: {
    level: "L1",
    allowCodeWrite: false,
    integrateAction: "none",
  },
  budget: {
    maxIterations: 20,
    maxCostUsd: 2.0,
    maxWallClockMs: 15 * 60_000,
    deadManMs: 5 * 60_000,
    sameErrorRepeatLimit: 3,
    noProgressIterations: 3,
    noToolCallIterations: 2,
  },
};

export default defaultConfig;
