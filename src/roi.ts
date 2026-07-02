/**
 * roi —— 投入产出 / 采纳率度量,回答「这个 loop 是技术自嗨还是真省事」。
 *
 * 框架核心指标:人工采纳率 < 50% = 经济上亏损。数据本就在 .loop 里:
 *   - escalation.resolution.chosen ∈ {approved, rejected} —— 人对 L2 提案的显式裁决
 *   - journal `unit_done` detail.integrate ∈ {merged, recorded} —— L3 自动合并 / L1 只读
 *   - budget-ledger.ndjson —— 累计成本
 * 这里把它们聚合成采纳率 + 单位成本 + verdict,缺的只是「把已有数据算出来」。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Escalation } from "./schema/state.ts";
import { createLedger } from "./ledger.ts";

export type RoiReport = {
  approved: number;          // 人工批准的提案数
  rejected: number;          // 人工驳回数
  decided: number;           // approved + rejected(有人裁决的总数)
  pending: number;           // 未解决的 escalation(还挂着等人)
  acceptRate: number | null; // approved / decided;无裁决时 null
  autoMerged: number;        // L3 自动合并(无需人,默认计入"被接受")
  recorded: number;          // L1 只读产出
  totalCostUsd: number;
  costPerAccepted: number | null; // 总成本 / (approved + autoMerged)
  verdict: "healthy" | "lossmaking" | "insufficient_data";
  warnings: string[];
};

/** 一个 loop 项目的采纳率/ROI。需要足够样本才下"亏损"结论。 */
export function computeRoi(loopDir: string, minSample = 3): RoiReport {
  let approved = 0;
  let rejected = 0;
  let pending = 0;

  const escDir = join(loopDir, "escalations");
  if (existsSync(escDir)) {
    for (const f of readdirSync(escDir)) {
      if (!f.endsWith(".json")) continue;
      let esc;
      try {
        esc = Escalation.parse(JSON.parse(readFileSync(join(escDir, f), "utf8")));
      } catch {
        continue;
      }
      const chosen = esc.resolution?.chosen;
      if (chosen === "approved") approved++;
      else if (chosen === "rejected") rejected++;
      else pending++;
    }
  }

  // journal:统计自动合并 / 只读产出
  let autoMerged = 0;
  let recorded = 0;
  const journalDir = join(loopDir, "journal");
  if (existsSync(journalDir)) {
    for (const f of readdirSync(journalDir)) {
      if (!f.endsWith(".ndjson")) continue;
      for (const line of readFileSync(join(journalDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.event === "unit_done") {
            if (e.detail?.integrate === "merged") autoMerged++;
            else if (e.detail?.integrate === "recorded") recorded++;
          }
        } catch {
          /* 跳过坏行 */
        }
      }
    }
  }

  const decided = approved + rejected;
  const acceptRate = decided > 0 ? approved / decided : null;
  const totalCostUsd = createLedger(loopDir).totals().costUsd;
  const acceptedOutputs = approved + autoMerged;
  const costPerAccepted = acceptedOutputs > 0 ? totalCostUsd / acceptedOutputs : null;

  const warnings: string[] = [];
  let verdict: RoiReport["verdict"];
  if (decided === 0 && autoMerged === 0) {
    verdict = "insufficient_data";
    warnings.push("还没有任何被裁决/合并的产出,无法评估 ROI。");
  } else if (acceptRate !== null && acceptRate < 0.5) {
    verdict = "lossmaking";
    warnings.push(
      `人工采纳率 ${(acceptRate * 100).toFixed(0)}% < 50% —— 这个 loop 在经济/时间上很可能亏损,考虑降级为单次 Prompt 或拆分子任务。`,
    );
    if (decided < minSample) warnings.push(`(样本仅 ${decided},结论待更多数据确认)`);
  } else {
    verdict = "healthy";
    if (acceptRate !== null && decided < minSample) {
      warnings.push(`样本仅 ${decided},采纳率 ${(acceptRate * 100).toFixed(0)}% 仅供参考。`);
    }
  }

  return {
    approved,
    rejected,
    decided,
    pending,
    acceptRate,
    autoMerged,
    recorded,
    totalCostUsd,
    costPerAccepted,
    verdict,
    warnings,
  };
}
