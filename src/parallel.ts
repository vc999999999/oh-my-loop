/**
 * parallel —— Phase 3:跨独立 unit 并行 + 串行 integrate(带冲突处理)。
 *
 * 蓝图铁律:并行的是独立 unit(各自一个 worktree、各跑完整串行流水线),
 *   不是阶段;只在 integrate 处串行合并(带冲突处理)。
 *
 * - 按 dependsOn 拓扑选出「现在可跑」的独立 unit,Promise.allSettled 并发跑各自流水线。
 * - 全部跑完后,串行 merge 回 base;冲突 → 该 unit escalate(risky),不污染 base。
 * 复用 worktree / gates / scope / snapshot 模块(与串行控制器同一套底座)。
 */

import { join } from "node:path";
import { ensureWorktree, changedFiles, commitAll, mergeWorktree, diffSummary } from "./worktree.ts";
import { createSnapshotManager } from "./snapshot.ts";
import { detectOutOfScope, revertCascade } from "./scope.ts";
import { runGates, type GateSpec } from "./gates.ts";
import type { LoopConfig } from "../loop.config.ts";
import type { CycleOutcome } from "./controller.ts";

export type ParallelUnit = {
  id: string;
  title: string;
  dependsOn?: string[];
  /** 实现步:在 worktree 内干活(返回 outcome)。 */
  implement: (workdir: string) => Promise<CycleOutcome>;
  /** 允许写的 scope(越界回滚)。 */
  scope: string[];
  /** verify 门。 */
  gates: GateSpec[];
};

export type UnitResult = {
  id: string;
  status: "verified" | "failed" | "error";
  worktree: string;
  detail: string;
};

export type IntegrateResult = {
  id: string;
  kind: "merged" | "conflict" | "skipped";
  output: string;
};

export type ParallelRunResult = {
  unitResults: UnitResult[];
  integrateResults: IntegrateResult[];
  conflicts: string[];
};

/** 拓扑:选出依赖已全部 done 的待跑 unit(一批)。 */
export function selectRunnable(units: ParallelUnit[], doneIds: Set<string>): ParallelUnit[] {
  return units.filter(
    (u) => !doneIds.has(u.id) && (u.dependsOn ?? []).every((d) => doneIds.has(d)),
  );
}

/** 跑一个 unit 的完整流水线(隔离 + scope + verify),不碰 base。 */
async function runUnitPipeline(unit: ParallelUnit, config: LoopConfig): Promise<UnitResult> {
  const wt = ensureWorktree(config.target, unit.id, config.baseBranch);
  const snap = createSnapshotManager({ snapshotDir: join(wt.path, ".loop", "snapshot"), root: wt.path });
  try {
    snap.createPreRunSnapshot();
  } catch {
    /* skip */
  }

  let outcome: CycleOutcome;
  try {
    outcome = await unit.implement(wt.path);
  } catch (e) {
    return { id: unit.id, status: "error", worktree: wt.path, detail: (e as Error).message };
  }
  if (outcome.signal === "error") {
    return { id: unit.id, status: "error", worktree: wt.path, detail: outcome.lastError ?? "error" };
  }

  // scope 强隔离:回滚越界写,再固化
  if (unit.scope.length) {
    const changed = changedFiles(wt.path, config.baseBranch ?? "HEAD");
    const oos = detectOutOfScope(changed, unit.scope);
    if (oos.length) revertCascade(wt.path, oos, snap);
  }
  commitAll(wt.path, `loop: ${unit.id}`);

  // verify 门
  const gr = runGates(unit.gates, wt.path);
  if (gr.verdict !== "pass") {
    return { id: unit.id, status: "failed", worktree: wt.path, detail: `gates ${gr.verdict}: ${gr.failing.map((g) => g.id).join(",")}` };
  }
  return { id: unit.id, status: "verified", worktree: wt.path, detail: diffSummary(wt.path, config.baseBranch ?? "HEAD") };
}

/**
 * 并发跑所有可跑 unit,然后串行 integrate(冲突隔离)。
 * 返回每个 unit 的流水线结果 + 合并结果 + 冲突列表。
 */
export async function runParallel(units: ParallelUnit[], config: LoopConfig): Promise<ParallelRunResult> {
  const doneIds = new Set<string>();
  const unitResults: UnitResult[] = [];

  // 按依赖分批并发(同批内并行,跨批串行)
  let guard = 0;
  while (doneIds.size < units.length && guard++ < units.length + 2) {
    const batch = selectRunnable(units, doneIds);
    if (!batch.length) break; // 剩下的有未满足依赖(或环)
    const settled = await Promise.allSettled(batch.map((u) => runUnitPipeline(u, config)));
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      const u = batch[i]!;
      if (s.status === "fulfilled") {
        unitResults.push(s.value);
      } else {
        unitResults.push({ id: u.id, status: "error", worktree: "", detail: String(s.reason) });
      }
      doneIds.add(u.id);
    }
  }

  // 串行 integrate:只合并 verified 的,冲突隔离
  const integrateResults: IntegrateResult[] = [];
  const conflicts: string[] = [];
  for (const r of unitResults) {
    if (r.status !== "verified") {
      integrateResults.push({ id: r.id, kind: "skipped", output: r.detail });
      continue;
    }
    const m = mergeWorktree(config.target, r.id, config.baseBranch);
    if (m.merged) {
      integrateResults.push({ id: r.id, kind: "merged", output: m.output });
    } else {
      integrateResults.push({ id: r.id, kind: "conflict", output: m.output });
      conflicts.push(r.id);
    }
  }

  return { unitResults, integrateResults, conflicts };
}
