/**
 * F2 测试:多任务队列 + 依赖图(串行控制器内的依赖编排)。
 */

import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runController, type Mode, type CycleOutcome } from "../src/controller.ts";
import { Unit } from "../src/schema/state.ts";
import type { LoopConfig } from "../loop.config.ts";
import type { GateSpec } from "../src/gates.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "q-"));
  execSync("git init -q -b main && git config user.email t@t.co && git config user.name t", { cwd: root });
  writeFileSync(join(root, "README.md"), "base\n");
  execSync("git add -A && git commit -qm init", { cwd: root });
  return root;
}

function cfg(root: string, gates: GateSpec[]): LoopConfig {
  return {
    target: root,
    loopDir: join(root, ".loop"),
    mode: "daily-triage",
    isolate: true,
    baseBranch: "main",
    gates,
    autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
    budget: { maxIterations: 200, deadManMs: 600_000, maxWallClockMs: 600_000, sameErrorRepeatLimit: 99, noProgressIterations: 99, noToolCallIterations: 99 } as any,
  };
}

/** 队列假 mode:seed 多 unit;implement 写 src/<id>.ts;记录完成顺序。 */
function queueWriterMode(specs: { id: string; dependsOn?: string[] }[], order: string[]): Mode {
  const build = (id: string, dependsOn?: string[]) =>
    Unit.parse({
      id,
      title: id,
      intent: "implement",
      status: "pending",
      dependsOn: dependsOn ?? [],
      cycles: [
        { id: `${id}-impl`, type: "implement", status: "pending", scope: ["src/"], maxAttempts: 2 },
        { id: `${id}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 2 },
      ],
    });
  return {
    planUnit: () => build(specs[0]!.id, specs[0]!.dependsOn),
    seedUnits: () => specs.map((s) => build(s.id, s.dependsOn)),
    async runCycle({ unit, cycle }): Promise<CycleOutcome> {
      if (cycle.type === "implement") {
        const abs = join(unit.worktree!, `src/${unit.id}.ts`);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, `export const id="${unit.id}"\n`);
        order.push(unit.id);
      }
      return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "ok", lastError: null, ranAgent: false };
    },
  };
}

// gate:每个 unit 验证自己的文件存在(用通配——实际用 git 已合并的 base 验)
const anyGate: GateSpec = {
  id: "g",
  criterion: "src dir has files",
  command: "ls src/*.ts",
  negativeControl: { command: "ls src/__none__/*.ts" },
};

test("依赖顺序:c(依赖 a,b)在 a、b 之后才跑", async () => {
  const root = gitRepo();
  try {
    const order: string[] = [];
    const mode = queueWriterMode([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a", "b"] }], order);
    const r = await runController(cfg(root, [anyGate]), mode);
    expect(r.outcome).toBe("done");
    // c 必须排在 a 和 b 之后
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
    expect(order.length).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("依赖死锁(成环)→ escalate(deadlock)", async () => {
  const root = gitRepo();
  try {
    const order: string[] = [];
    // x 依赖 y,y 依赖 x → 谁都跑不了
    const mode = queueWriterMode([{ id: "x", dependsOn: ["y"] }, { id: "y", dependsOn: ["x"] }], order);
    const r = await runController(cfg(root, [anyGate]), mode);
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("deadlock");
    expect(order.length).toBe(0); // 一个都没跑
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedUnits 播种全部 unit(一次性)", async () => {
  const root = gitRepo();
  try {
    const order: string[] = [];
    const mode = queueWriterMode([{ id: "u1" }, { id: "u2" }, { id: "u3" }], order);
    const r = await runController(cfg(root, [anyGate]), mode);
    expect(r.outcome).toBe("done");
    expect(r.state.units.map((u) => u.id).sort()).toEqual(["u1", "u2", "u3"]);
    expect(r.state.units.every((u) => u.status === "done")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
