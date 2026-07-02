/**
 * transient-retry —— 瞬态 provider 错误按 partial 重试,非瞬态错误仍硬停。
 *
 * 背景(live 实测):explore→implement 连续 spawn 时 provider 偶发
 * "unknown certificate verification error";旧行为第一次就 escalate 要人介入。
 * 新行为:瞬态错误消耗 attempt 重试(退避可配),非瞬态照旧硬停。
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
  const root = mkdtempSync(join(tmpdir(), "transient-"));
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

/** 假 mode:implement 前 failTimes 次返回指定 error,之后写文件成功。 */
function flakyMode(unitId: string, failTimes: number, errMsg: string): Mode {
  let calls = 0;
  return {
    planUnit() {
      return Unit.parse({
        id: unitId,
        title: "flaky",
        intent: "implement",
        status: "pending",
        cycles: [
          { id: `${unitId}-impl`, type: "implement", status: "pending", scope: ["src/"], maxAttempts: 3 },
          { id: `${unitId}-verify`, type: "verify", status: "pending", scope: [], maxAttempts: 3 },
        ],
      });
    },
    async runCycle({ unit, cycle }): Promise<CycleOutcome> {
      if (cycle.type === "implement") {
        calls++;
        if (calls <= failTimes) {
          return { signal: "error", steps: [], toolCallCount: 0, finalText: null, lastError: errMsg, ranAgent: true };
        }
        const abs = join(unit.worktree!, "src/feature.ts");
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, "export const x = 1;\n");
      }
      return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "done", lastError: null, ranAgent: true };
    },
  };
}

const gate: GateSpec = {
  id: "file-exists",
  criterion: "src/feature.ts 存在",
  command: "test -f src/feature.ts",
  negativeControl: { command: "test -f src/feature.ts.__nope__" },
};

test("瞬态 provider 错误(TLS):消耗 attempt 重试,最终 done", async () => {
  const root = gitRepo();
  try {
    const r = await runController(
      cfg(root, { gates: [gate] }),
      flakyMode("flaky1", 1, "unknown certificate verification error"),
    );
    expect(r.outcome).toBe("done");
    const impl = r.state.units[0]!.cycles.find((c) => c.id === "flaky1-impl")!;
    expect(impl.attempts).toBe(1); // 失败一次消耗了一个 attempt
    expect(impl.status).toBe("done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("瞬态错误持续超过 maxAttempts:escalate(retries_exhausted),不无限重试", async () => {
  const root = gitRepo();
  try {
    const r = await runController(
      cfg(root, { gates: [gate] }),
      flakyMode("flaky2", 99, "ECONNRESET: socket hang up"),
    );
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("retries_exhausted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("连续瞬态错误不误触 no_tool_call 熔断(0 工具调用不计入空转历史)", async () => {
  const root = gitRepo();
  try {
    const r = await runController(
      cfg(root, { gates: [gate], budget: { maxIterations: 50, deadManMs: 600_000, maxWallClockMs: 600_000, sameErrorRepeatLimit: 99, noProgressIterations: 99, noToolCallIterations: 2 } as any }),
      flakyMode("flaky4", 2, "unknown certificate verification error"),
    );
    // 连续 2 次瞬态失败(toolCalls=0)后第 3 次成功 → 不应被 no_tool_call 熔断
    expect(r.reason).not.toBe("no_tool_call");
    expect(r.outcome).toBe("done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非瞬态进程级错误:仍第一次就硬停 escalate(error)", async () => {
  const root = gitRepo();
  try {
    const r = await runController(
      cfg(root, { gates: [gate] }),
      flakyMode("flaky3", 99, "SyntaxError: unexpected token in agent output"),
    );
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("error");
    const impl = r.state.units[0]!.cycles.find((c) => c.id === "flaky3-impl")!;
    expect(impl.status).toBe("blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
