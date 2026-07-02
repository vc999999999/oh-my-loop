/**
 * task-mode —— Phase 1+ 的通用任务模式:explore → implement → verify。
 *
 * 在隔离 worktree 内驱动真实 opencode agent 干活;verify cycle 由控制器跑 gates。
 * implement 之后把改动 commit(固化,便于 verify/integrate)。
 * maker(implement)用 build agent;Phase 2 verify 改用 fresh-context review agent。
 */

import { Unit } from "../schema/state.ts";
import type { Mode, CycleOutcome } from "../controller.ts";
import { runSession } from "../opencode-runner.ts";
import { explorePrompt, implementPrompt } from "../prompts.ts";

export type TaskSpec = {
  id: string;
  title: string;
  /** 给 implement agent 的指令。 */
  instruction: string;
  /** implement 允许写的 scope(file-path 前缀)。越界自动回滚。 */
  scope: string[];
  intent?: "implement" | "fix" | "edit" | "create";
};

export function createTaskMode(task: TaskSpec): Mode {
  return {
    planUnit() {
      return Unit.parse({
        id: task.id,
        title: task.title,
        intent: task.intent ?? "implement",
        status: "pending",
        cycles: [
          { id: `${task.id}-explore`, type: "explore", status: "pending", scope: [], maxAttempts: 2 },
          { id: `${task.id}-implement`, type: "implement", status: "pending", scope: task.scope, maxAttempts: 3 },
          { id: `${task.id}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 3 },
        ],
      });
    },

    async runCycle({ unit, cycle, config }): Promise<CycleOutcome> {
      const cwd = unit.worktree ?? config.target;
      const commonRun = {
        cwd,
        model: config.model ?? null,
        agent: config.agents?.maker ?? null,
        deadManMs: config.budget.deadManMs ?? 300_000,
        wallClockMs: config.budget.perCycleWallClockMs ?? config.budget.maxWallClockMs ?? 900_000,
      };

      if (cycle.type === "explore") {
        const run = await runSession({
          ...commonRun,
          prompt: explorePrompt(task.instruction),
        });
        // 计划持久化在 unit 上(state.json),implement 复用,resume 不丢
        if (run.signal === "cycle_complete" && run.finalText) unit.explorePlan = run.finalText;
        return toOutcome(run);
      }

      if (cycle.type === "implement") {
        const run = await runSession({
          ...commonRun,
          prompt: implementPrompt({
            instruction: task.instruction,
            scope: task.scope,
            lastError: cycle.lastError,
            plan: unit.explorePlan,
          }),
        });
        // 注意:不在此 commit。控制器会在 scope 越界回滚之后再 commit,
        // 否则越界文件会先被固化进 commit,git restore/clean 回滚不掉。
        return toOutcome(run);
      }

      // verify 由控制器跑 gates,不走这里(兜底)
      return { signal: "cycle_complete", steps: [], toolCallCount: 0, finalText: null, lastError: null };
    },
  };
}

function toOutcome(run: Awaited<ReturnType<typeof runSession>>): CycleOutcome {
  return {
    signal: run.signal,
    steps: run.steps,
    toolCallCount: run.toolCallCount,
    finalText: run.finalText,
    lastError: run.lastError,
    ranAgent: true,
  };
}
