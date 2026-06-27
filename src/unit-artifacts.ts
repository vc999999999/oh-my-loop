/**
 * unit-artifacts —— 每个 unit 的可审计产物落盘到 .loop/units/<id>/。
 *
 * 实现 design/README.md 的 `.loop/` 约定:units/<id>/ 存「diff + verifier 报告」。
 * 在 unit 到达终态(integrate 前 / blocked)时调用,把 state.json 里内嵌的 gate 证据
 * 外化成独立文件,人和工具都能直接读,不必去 state.json 里捞。
 *
 *   verify.json       —— 全部 cycle 的 gate verdict + 原始输出 + negative control 结果
 *   diff.patch        —— worktree 相对 base 的完整 patch(有 worktree 才有)
 *   diff-summary.txt  —— shortstat 摘要
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Unit as UnitT } from "./schema/state.ts";
import { diffPatch, diffSummary } from "./worktree.ts";

export function writeUnitArtifacts(
  loopDir: string,
  unit: UnitT,
  opts: { baseBranch?: string; integrate?: string } = {},
): void {
  const dir = join(loopDir, "units", unit.id);
  mkdirSync(dir, { recursive: true });

  // gate 证据:从所有 cycle 收集(verify cycle 才有 gates)
  const gates = unit.cycles.flatMap((c) => (c.gates ?? []).map((g) => ({ cycle: c.id, ...g })));
  const verify = {
    unitId: unit.id,
    title: unit.title,
    status: unit.status,
    integrate: opts.integrate ?? null,
    lastError: unit.lastError ?? null,
    writtenAt: new Date().toISOString(),
    gates,
  };
  writeFileSync(join(dir, "verify.json"), JSON.stringify(verify, null, 2), "utf8");

  // diff:完整 patch + 摘要(必须在 integrate/merge 之前调,否则合并后 diff 为空)
  if (unit.worktree) {
    const base = opts.baseBranch ?? "HEAD";
    const patch = diffPatch(unit.worktree, base);
    if (patch) writeFileSync(join(dir, "diff.patch"), patch, "utf8");
    const summary = diffSummary(unit.worktree, base);
    if (summary) writeFileSync(join(dir, "diff-summary.txt"), summary + "\n", "utf8");
  }
}
