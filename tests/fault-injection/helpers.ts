/**
 * 故障注入测试辅助:临时 loopDir + 可控 test mode + config 构造。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopConfig } from "../../loop.config.ts";
import type { Mode, CycleOutcome } from "../../src/controller.ts";
import { Unit } from "../../src/schema/state.ts";

export function tmpLoopDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(loopDir: string, over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    target: loopDir,
    loopDir,
    mode: "daily-triage",
    autonomy: { level: "L1", allowCodeWrite: false, integrateAction: "none" },
    budget: {
      maxIterations: 50,
      maxCostUsd: 100,
      maxWallClockMs: 600_000,
      deadManMs: 600_000,
      sameErrorRepeatLimit: 3,
      noProgressIterations: 99, // 默认关掉,单测里按需打开
      noToolCallIterations: 99,
    },
    ...over,
  };
}

/** 可控 mode:N 个 cycle,每个 cycle 的 outcome 由 fn 决定;记录每个 cycle 被跑几次。 */
export function testMode(
  cycleIds: string[],
  outcomeFor: (cycleId: string, runs: number) => CycleOutcome,
): Mode & { runs: Record<string, number>; unitDone: number } {
  const runs: Record<string, number> = {};
  const mode = {
    runs,
    unitDone: 0,
    planUnit() {
      return Unit.parse({
        id: "u1",
        title: "test unit",
        intent: "fix",
        status: "pending",
        cycles: cycleIds.map((id) => ({ id, type: "explore", status: "pending", scope: [], maxAttempts: 2 })),
      });
    },
    async runCycle({ cycle }: any): Promise<CycleOutcome> {
      runs[cycle.id] = (runs[cycle.id] ?? 0) + 1;
      return outcomeFor(cycle.id, runs[cycle.id]);
    },
    onUnitDone() {
      mode.unitDone++;
    },
  };
  return mode;
}

export const complete = (): CycleOutcome => ({
  signal: "cycle_complete",
  steps: [],
  toolCallCount: 1,
  finalText: "ok",
  lastError: null,
  ranAgent: false,
});
