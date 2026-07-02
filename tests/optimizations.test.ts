/**
 * optimizations —— 四项结构性优化的回归测试:
 *   1. resume 时 budget limits 以 config 为准 + 墙钟起点重置(「提高预算重跑」生效)
 *   2. explorePlan 持久化(schema)+ 注入 implement prompt(含截断)
 *   3. perCycleWallClockMs 与总墙钟拆分(schema 层)
 *   4. agents.maker/checker 配置透传(reviewer 入参)
 */

import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runController, type Mode, type CycleOutcome } from "../src/controller.ts";
import { Unit, BudgetLimits } from "../src/schema/state.ts";
import { implementPrompt } from "../src/prompts.ts";
import type { LoopConfig } from "../loop.config.ts";
import type { GateSpec } from "../src/gates.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "opt-"));
  execSync("git init -q -b main && git config user.email t@t.co && git config user.name t", { cwd: root });
  writeFileSync(join(root, "README.md"), "base\n");
  execSync("git add -A && git commit -qm init", { cwd: root });
  return root;
}

function cfg(root: string, over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    target: root,
    loopDir: join(root, ".loop"),
    mode: "daily-triage",
    isolate: true,
    baseBranch: "main",
    transientBackoffMs: 10,
    autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
    budget: { maxIterations: 50, deadManMs: 600_000, maxWallClockMs: 600_000, sameErrorRepeatLimit: 99, noProgressIterations: 99, noToolCallIterations: 99 } as any,
    ...over,
  };
}

const gate: GateSpec = {
  id: "file-exists",
  criterion: "src/feature.ts 存在",
  command: "test -f src/feature.ts",
  negativeControl: { command: "test -f src/feature.ts.__nope__" },
};

/** 假 mode:succeed=false 时 implement 永远 partial(错误信息带序号防同错误指纹);true 时写文件成功。 */
function stubMode(unitId: string, succeed: boolean): Mode {
  let n = 0;
  return {
    planUnit() {
      return Unit.parse({
        id: unitId,
        title: "opt",
        intent: "implement",
        status: "pending",
        cycles: [
          { id: `${unitId}-impl`, type: "implement", status: "pending", scope: ["src/"], maxAttempts: 10 },
          { id: `${unitId}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 3 },
        ],
      });
    },
    async runCycle({ unit, cycle }): Promise<CycleOutcome> {
      if (cycle.type === "implement" && !succeed) {
        n++;
        return { signal: "cycle_partial", steps: [], toolCallCount: 1, finalText: null, lastError: `still working ${n}`, ranAgent: true };
      }
      if (cycle.type === "implement") {
        const abs = join(unit.worktree!, "src/feature.ts");
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, "export const x = 1;\n");
      }
      return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "done", lastError: null, ranAgent: true };
    },
  };
}

test("resume:limits 以新 config 为准 + 墙钟起点重置 → 预算熔断后提额重跑能跑完", async () => {
  const root = gitRepo();
  try {
    // 第一跑:maxIterations=2,implement 永远 partial → iteration 熔断 escalate
    const r1 = await runController(
      cfg(root, { gates: [gate], budget: { maxIterations: 2, deadManMs: 600_000, maxWallClockMs: 600_000, sameErrorRepeatLimit: 99, noProgressIterations: 99, noToolCallIterations: 99 } as any }),
      stubMode("res1", false),
    );
    expect(r1.outcome).toBe("escalated");
    expect(r1.reason).toBe("iteration");

    // 第二跑:同一 .loop/state.json,提高预算。旧行为会带着旧 limits 立刻再熔断。
    const before = Date.now();
    const r2 = await runController(cfg(root, { gates: [gate] }), stubMode("res1", true));
    expect(r2.outcome).toBe("done");
    expect(r2.state.budget.limits.maxIterations).toBe(50); // limits 已刷新
    expect(r2.state.budget.usage.iterations).toBeGreaterThan(2); // usage 照旧跨会话累计
    expect(Date.parse(r2.state.budget.usage.startedAt)).toBeGreaterThanOrEqual(before - 1_000); // 墙钟重置
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explorePlan:Unit schema 持久化往返", () => {
  const u = Unit.parse({ id: "u", title: "t", intent: "implement", explorePlan: "改 src/a.ts 的 foo()" });
  expect(Unit.parse(JSON.parse(JSON.stringify(u))).explorePlan).toBe("改 src/a.ts 的 foo()");
});

test("implementPrompt:注入 explore 计划并截断超长计划", () => {
  const withPlan = implementPrompt({ instruction: "x", scope: [], plan: "PLAN-MARKER 改 src/a.ts" });
  expect(withPlan).toContain("前置探查已完成");
  expect(withPlan).toContain("PLAN-MARKER");

  const longPlan = "H".repeat(100) + "T".repeat(10_000);
  const truncated = implementPrompt({ instruction: "x", scope: [], plan: longPlan });
  expect(truncated).toContain("H".repeat(100));
  expect(truncated.length).toBeLessThan(longPlan.length); // 尾部被截掉

  expect(implementPrompt({ instruction: "x", scope: [] })).not.toContain("前置探查");
});

test("BudgetLimits:perCycleWallClockMs 可选字段解析", () => {
  const l = BudgetLimits.parse({ maxWallClockMs: 600_000, perCycleWallClockMs: 120_000 });
  expect(l.perCycleWallClockMs).toBe(120_000);
  expect(BudgetLimits.parse({}).perCycleWallClockMs).toBeUndefined();
});
