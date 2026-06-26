/**
 * Phase 1 测试:worktree 隔离 + scope 强隔离 + verify gate + integrate(L2/L3)。
 * 用假 mode(implement cycle 往 worktree 写文件)替代真 opencode,确定性可测。
 */

import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runController, type Mode, type CycleOutcome } from "../src/controller.ts";
import { Unit } from "../src/schema/state.ts";
import type { LoopConfig } from "../loop.config.ts";
import type { GateSpec } from "../src/gates.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "p1-"));
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
    autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
    budget: { maxIterations: 50, deadManMs: 600_000, maxWallClockMs: 600_000, sameErrorRepeatLimit: 99, noProgressIterations: 99, noToolCallIterations: 99 } as any,
    ...over,
  };
}

/** 假 mode:implement cycle 把 writes(相对路径→内容)写进 worktree。 */
function writerMode(unitId: string, writes: Record<string, string>, scope: string[]): Mode {
  return {
    planUnit() {
      return Unit.parse({
        id: unitId,
        title: "writer",
        intent: "implement",
        status: "pending",
        cycles: [
          { id: `${unitId}-impl`, type: "implement", status: "pending", scope, maxAttempts: 3 },
          { id: `${unitId}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 3 },
        ],
      });
    },
    async runCycle({ unit, cycle }): Promise<CycleOutcome> {
      if (cycle.type === "implement") {
        for (const [rel, content] of Object.entries(writes)) {
          const abs = join(unit.worktree!, rel);
          mkdirSync(join(abs, ".."), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "done", lastError: null, ranAgent: false };
    },
  };
}

const fileGate = (file: string): GateSpec => ({
  id: "file-exists",
  criterion: `${file} 存在`,
  command: `test -f ${file}`,
  negativeControl: { command: `test -f ${file}.__nope__` },
});

test("worktree 隔离 + verify pass + L3 白名单内 auto-merge", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root, { gates: [fileGate("src/feature.ts")] });
    const r = await runController(config, writerMode("feat1", { "src/feature.ts": "export const x=1\n" }, ["src/"]));
    expect(r.outcome).toBe("done");
    // worktree 建过
    expect(existsSync(join(root, ".loop/worktrees/feat1"))).toBe(true);
    // L3 auto-merge:base 分支(main)现在有 src/feature.ts
    const onMain = execSync("git show main:src/feature.ts", { cwd: root, stdio: "pipe" }).toString();
    expect(onMain).toContain("export const x=1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope 强隔离:越界写被回滚,in-scope 保留", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root, {
      gates: [fileGate("src/ok.ts")],
      autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
    });
    // implement 写 src/ok.ts(in scope)+ evil.ts(out of scope)
    const r = await runController(config, writerMode("feat2", { "src/ok.ts": "ok\n", "evil.ts": "BAD\n" }, ["src/"]));
    expect(r.outcome).toBe("done");
    const wt = join(root, ".loop/worktrees/feat2");
    expect(existsSync(join(wt, "src/ok.ts"))).toBe(true); // in-scope 保留
    expect(existsSync(join(wt, "evil.ts"))).toBe(false); // 越界被回滚
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate fail → 回边重试 → 耗尽 escalate", async () => {
  const root = gitRepo();
  try {
    // gate 要求 src/feature.ts 存在,但 mode 只写 other.ts → 永远 fail
    const config = cfg(root, { gates: [fileGate("src/feature.ts")] });
    const mode = writerMode("feat3", { "src/other.ts": "x\n" }, ["src/"]);
    // 把 verify 的 maxAttempts 调小,加速耗尽
    const orig = mode.planUnit;
    mode.planUnit = (s, c) => {
      const u = orig(s, c);
      u.cycles.find((x) => x.type === "verify")!.maxAttempts = 2;
      return u;
    };
    const r = await runController(config, mode);
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("retries_exhausted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L2 propose:完成后出提案 + escalate 待批准(不自动 merge)", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root, {
      gates: [fileGate("src/f.ts")],
      autonomy: { level: "L2", allowCodeWrite: true, integrateAction: "propose" },
    });
    const r = await runController(config, writerMode("feat4", { "src/f.ts": "y\n" }, ["src/"]));
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("awaiting_approval");
    expect(existsSync(join(root, ".loop/proposals/feat4.md"))).toBe(true);
    // 没有自动合并到 main
    let merged = true;
    try {
      execSync("git show main:src/f.ts", { cwd: root, stdio: "pipe" });
    } catch {
      merged = false;
    }
    expect(merged).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L3 越白名单 → 不自动 merge,转提案", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root, {
      gates: [fileGate("lib/x.ts")],
      autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
    });
    // 写到 lib/(白名单只有 src/),但 scope 允许 lib/ 所以不被回滚
    const r = await runController(config, writerMode("feat5", { "lib/x.ts": "z\n" }, ["lib/"]));
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("awaiting_approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
