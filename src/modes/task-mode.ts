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
        deadManMs: config.budget.deadManMs ?? 300_000,
        wallClockMs: config.budget.maxWallClockMs ?? 900_000,
      };

      if (cycle.type === "explore") {
        const run = await runSession({
          ...commonRun,
          prompt: `只读探查仓库,为这个任务规划改动范围(不要改任何文件):${task.instruction}`,
        });
        return toOutcome(run);
      }

      if (cycle.type === "implement") {
        const errCtx = cycle.lastError ? `\n\n上一轮 verify 失败,必须修复:${cycle.lastError}` : "";
        const run = await runSession({
          ...commonRun,
          prompt:
            `实现以下任务。只改这些路径范围内的文件:${task.scope.join(", ") || "(无限制)"}。` +
            `写完确保代码可运行。\n\n任务:${task.instruction}${errCtx}`,
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
