/**
 * Phase 3 测试:并行独立 unit + 串行 integrate(冲突隔离)+ 拓扑排序。
 */

import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParallel, selectRunnable, type ParallelUnit } from "../src/parallel.ts";
import type { LoopConfig } from "../loop.config.ts";
import type { GateSpec } from "../src/gates.ts";
import type { CycleOutcome } from "../src/controller.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "p3-"));
  execSync("git init -q -b main && git config user.email t@t.co && git config user.name t", { cwd: root });
  writeFileSync(join(root, "README.md"), "line1\nline2\nline3\n");
  execSync("git add -A && git commit -qm init", { cwd: root });
  return root;
}

function cfg(root: string): LoopConfig {
  return {
    target: root,
    loopDir: join(root, ".loop"),
    mode: "daily-triage",
    isolate: true,
    baseBranch: "main",
    autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto" },
    budget: { deadManMs: 600_000, maxWallClockMs: 600_000 } as any,
  };
}

const fileGate = (file: string): GateSpec => ({
  id: `exists-${file}`,
  criterion: `${file} exists`,
  command: `test -f ${file}`,
  negativeControl: { command: `test -f ${file}.__nope__` },
});

function writeUnit(id: string, rel: string, content: string, deps?: string[]): ParallelUnit {
  return {
    id,
    title: id,
    dependsOn: deps,
    scope: ["src/"],
    gates: [fileGate(rel)],
    implement: async (workdir): Promise<CycleOutcome> => {
      const abs = join(workdir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "ok", lastError: null, ranAgent: false };
    },
  };
}

test("拓扑选取:依赖未完成不可跑", () => {
  const units = [writeUnit("a", "src/a.ts", "a"), writeUnit("b", "src/b.ts", "b", ["a"])];
  expect(selectRunnable(units, new Set()).map((u) => u.id)).toEqual(["a"]);
  expect(selectRunnable(units, new Set(["a"])).map((u) => u.id)).toEqual(["b"]);
});

test("并行独立 unit:都 verified 且都 merge 进 base", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root);
    const units = [writeUnit("u1", "src/one.ts", "1\n"), writeUnit("u2", "src/two.ts", "2\n")];
    const r = await runParallel(units, config);
    expect(r.unitResults.every((x) => x.status === "verified")).toBe(true);
    expect(r.integrateResults.every((x) => x.kind === "merged")).toBe(true);
    expect(r.conflicts).toEqual([]);
    // base 上两个文件都在
    expect(execSync("git show main:src/one.ts", { cwd: root }).toString()).toContain("1");
    expect(execSync("git show main:src/two.ts", { cwd: root }).toString()).toContain("2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("合并冲突:第二个 unit 冲突被隔离,base 不被污染", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root);
    // 两个 unit 改同一个已存在文件的同一区域 → 第二个合并冲突
    const conflictUnit = (id: string, content: string): ParallelUnit => ({
      id,
      title: id,
      scope: [], // 允许改 README(根)
      gates: [fileGate("README.md")],
      implement: async (workdir): Promise<CycleOutcome> => {
        writeFileSync(join(workdir, "README.md"), content);
        return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "ok", lastError: null, ranAgent: false };
      },
    });
    const units = [conflictUnit("c1", "AAA\nline2\nline3\n"), conflictUnit("c2", "BBB\nline2\nline3\n")];
    const r = await runParallel(units, config);
    // 第一个 merge 成功,第二个冲突
    expect(r.integrateResults.find((x) => x.id === "c1")?.kind).toBe("merged");
    expect(r.integrateResults.find((x) => x.id === "c2")?.kind).toBe("conflict");
    expect(r.conflicts).toContain("c2");
    // base 处于干净状态(无半合并 / 无冲突标记),忽略控制器自己的 .loop/ 产物
    const status = execSync("git status --porcelain", { cwd: root })
      .toString()
      .split("\n")
      .filter((l) => l.trim() && !l.includes(".loop/"));
    expect(status).toEqual([]); // 冲突已 abort,无残留
    expect(execSync("git show main:README.md", { cwd: root }).toString()).toContain("AAA");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify 失败的 unit 不 merge(skipped)", async () => {
  const root = gitRepo();
  try {
    const config = cfg(root);
    // gate 要 src/x.ts,但 unit 写 src/y.ts → verify fail → skip integrate
    const u: ParallelUnit = {
      id: "uf",
      title: "uf",
      scope: ["src/"],
      gates: [fileGate("src/x.ts")],
      implement: async (workdir): Promise<CycleOutcome> => {
        const abs = join(workdir, "src/y.ts");
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, "y\n");
        return { signal: "cycle_complete", steps: [], toolCallCount: 1, finalText: "ok", lastError: null, ranAgent: false };
      },
    };
    const r = await runParallel([u], config);
    expect(r.unitResults[0]!.status).toBe("failed");
    expect(r.integrateResults[0]!.kind).toBe("skipped");
    // base 没有 src/y.ts
    let onBase = true;
    try {
      execSync("git show main:src/y.ts", { cwd: root, stdio: "pipe" });
    } catch {
      onBase = false;
    }
    expect(onBase).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
