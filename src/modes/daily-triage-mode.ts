/**
 * daily-triage-mode —— 把 daily-triage 包装成 controller 的 Mode。
 *
 * planUnit:造一个含若干只读 scan cycle 的 unit(多 cycle → kill-9 resume 可验"不重做")。
 * runCycle:跑对应 scan 步;最后一个 cycle 调 AI 总结(可选)。
 * onUnitDone:写 STATE.md。
 */

import { Unit } from "../schema/state.ts";
import type { Mode, CycleOutcome } from "../controller.ts";
import { localScan, runTriage, writeStateMd, type TriageReport } from "./daily-triage.ts";

const SCAN_CYCLES = ["scan-git", "scan-todos", "ai-summary"] as const;

// 模式内存:本轮 triage 报告(跨 cycle 累积)。
let currentReport: TriageReport | null = null;

export function createDailyTriageMode(): Mode {
  return {
    planUnit(_state, config) {
      currentReport = localScan(config.target);
      return Unit.parse({
        id: `triage-${new Date().toISOString().slice(0, 10)}`,
        title: `daily triage: ${config.target}`,
        intent: "fix",
        status: "pending",
        cycles: SCAN_CYCLES.map((id) => ({
          id,
          type: "explore",
          status: "pending",
          scope: [], // 只读,无写 scope
          maxAttempts: 2,
        })),
      });
    },

    async runCycle({ cycle, config }): Promise<CycleOutcome> {
      if (!currentReport) currentReport = localScan(config.target);

      if (cycle.id === "scan-git") {
        // git 状态已在 localScan 拿到,这里只是确认非空响应
        return ok(currentReport.recentCommits ? 1 : 0, `git scanned`);
      }
      if (cycle.id === "scan-todos") {
        return ok(0, `todos: ${currentReport.todoCount}`);
      }
      if (cycle.id === "ai-summary") {
        // 可选:用 opencode 跑只读 AI 总结。useAgent 默认 false(Phase 0 不强依赖网络/model)。
        const useAgent = process.env.LOOP_USE_AGENT === "1";
        const { report, run } = await runTriage(config.target, {
          deadManMs: config.budget.deadManMs ?? 300_000,
          wallClockMs: config.budget.maxWallClockMs ?? 900_000,
          model: config.model ?? null,
          useAgent,
        });
        currentReport = report;
        if (run) {
          return {
            signal: run.signal,
            steps: run.steps,
            toolCallCount: run.toolCallCount,
            finalText: run.finalText,
            lastError: run.lastError,
            ranAgent: true,
          };
        }
        return ok(0, report.agentSummary ?? "local scan only");
      }
      return ok(0, "unknown cycle");
    },

    onUnitDone(_state, _unit, config) {
      const report = currentReport ?? localScan(config.target);
      writeStateMd(
        config.loopDir,
        report,
        `## 控制器\n\n- 自治等级:${config.autonomy.level}(只读,allowCodeWrite=${config.autonomy.allowCodeWrite})\n- 本次未做任何代码改动。`,
      );
    },
  };
}

function ok(toolCallCount: number, text: string): CycleOutcome {
  return { signal: "cycle_complete", steps: [], toolCallCount, finalText: text, lastError: null };
}
