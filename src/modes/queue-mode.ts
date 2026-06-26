/**
 * queue-mode —— F2:多任务队列 + 依赖图。
 *
 * 一次性播种多个 unit(每个 explore→implement→verify),带 dependsOn。
 * 控制器按依赖拓扑依次跑(serial),依赖未满足的 unit 自动延后,成环则死锁 escalate。
 * (并行版见 parallel.ts;此处是串行控制器内的依赖编排。)
 */

import { Unit } from "../schema/state.ts";
import type { Mode, CycleOutcome } from "../controller.ts";
import { runSession } from "../opencode-runner.ts";

export type QueueTask = {
  id: string;
  title: string;
  instruction: string;
  scope: string[];
  dependsOn?: string[];
  intent?: "implement" | "fix" | "edit" | "create";
};

export function createQueueMode(tasks: QueueTask[]): Mode {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  return {
    // 单 unit 路径用不到(seedUnits 已播种全部);保留兜底。
    planUnit() {
      const t = tasks[0]!;
      return buildUnit(t);
    },

    seedUnits() {
      return tasks.map(buildUnit);
    },

    async runCycle({ unit, cycle, config }): Promise<CycleOutcome> {
      const task = byId.get(unit.id);
      if (!task) return done("unknown unit");
      const cwd = unit.worktree ?? config.target;
      const common = {
        cwd,
        model: config.model ?? null,
        deadManMs: config.budget.deadManMs ?? 300_000,
        wallClockMs: config.budget.maxWallClockMs ?? 900_000,
      };

      if (cycle.type === "explore") {
        const run = await runSession({ ...common, prompt: `只读探查,为任务规划改动(不要改文件):${task.instruction}` });
        return toOutcome(run);
      }
      if (cycle.type === "implement") {
        const errCtx = cycle.lastError ? `\n\n上轮 verify 失败,必须修复:${cycle.lastError}` : "";
        const run = await runSession({
          ...common,
          prompt: `实现任务,只改这些路径:${task.scope.join(", ") || "(无限制)"}。\n\n任务:${task.instruction}${errCtx}`,
        });
        return toOutcome(run);
      }
      return done("noop"); // verify 由控制器跑 gates
    },
  };
}

function buildUnit(t: QueueTask) {
  return Unit.parse({
    id: t.id,
    title: t.title,
    intent: t.intent ?? "implement",
    status: "pending",
    dependsOn: t.dependsOn ?? [],
    cycles: [
      { id: `${t.id}-explore`, type: "explore", status: "pending", scope: [], maxAttempts: 2 },
      { id: `${t.id}-implement`, type: "implement", status: "pending", scope: t.scope, maxAttempts: 3 },
      { id: `${t.id}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 3 },
    ],
  });
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

function done(text: string): CycleOutcome {
  return { signal: "cycle_complete", steps: [], toolCallCount: 0, finalText: text, lastError: null, ranAgent: false };
}
