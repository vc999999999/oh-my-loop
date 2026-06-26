/**
 * F3 escalation 去重/聚合 + F4 批准闭环 测试。
 */

import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../src/journal.ts";
import { createEscalator } from "../src/escalation.ts";
import { createStateStore } from "../src/state-store.ts";
import { ensureWorktree, commitAll } from "../src/worktree.ts";

function initState(dir: string) {
  const store = createStateStore(dir);
  return store.init({
    goalStatement: "t",
    mode: "daily-triage",
    autonomy: { level: "L2", allowlistPaths: [], allowedCycleTypes: ["explore"], integrateAction: "propose", allowCodeWrite: true },
    budget: { limits: { maxTurnsPerCycle: 500, deadManMs: 1000, sameErrorRepeatLimit: 3, noProgressIterations: 3, noToolCallIterations: 2, reserveUsd: 0.1 }, usage: { iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, startedAt: new Date().toISOString() } },
  });
}

test("F3: 同 root cause 多次升级聚合成一条(不刷屏)", () => {
  const dir = mkdtempSync(join(tmpdir(), "esc-"));
  try {
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal);
    const state = initState(dir);

    // 同样的 reason + 同样的错误(只是 unit 不同)→ 应聚合
    const id1 = esc.escalate(state, { reason: "retries_exhausted", unitId: "u1", lastError: "TypeError at /a/b.ts:10", humanQuestion: "?" });
    const id2 = esc.escalate(state, { reason: "retries_exhausted", unitId: "u2", lastError: "TypeError at /c/d.ts:20", humanQuestion: "?" });
    // 归一化后 /a/b.ts:10 与 /c/d.ts:20 都变成 <path>:<pos> → 同指纹
    expect(id2).toBe(id1); // 聚合到同一条
    expect(readdirSync(join(dir, "escalations")).length).toBe(1); // 只有一个文件
    const merged = esc.read(id1)!;
    expect(merged.affectedUnits.sort()).toEqual(["u1", "u2"]);
    expect(merged.occurrences).toBe(2);
    // escalationIds 只记一次
    expect(state.escalationIds.filter((x) => x === id1).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: 不同 reason 不聚合", () => {
  const dir = mkdtempSync(join(tmpdir(), "esc2-"));
  try {
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal);
    const state = initState(dir);
    const id1 = esc.escalate(state, { reason: "budget", lastError: "x", humanQuestion: "?" });
    const id2 = esc.escalate(state, { reason: "verifier_invalid", lastError: "x", humanQuestion: "?" });
    expect(id2).not.toBe(id1);
    expect(readdirSync(join(dir, "escalations")).length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F4: approve 把 unit 的 worktree merge 回 base + 写决议", () => {
  const root = mkdtempSync(join(tmpdir(), "appr-"));
  try {
    execSync("git init -q -b main && git config user.email t@t.co && git config user.name t", { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n");
    execSync("git add -A && git commit -qm init", { cwd: root });

    const loopDir = join(root, ".loop");
    const journal = createJournal(loopDir);
    const esc = createEscalator(loopDir, journal);
    const store = createStateStore(loopDir);
    const state = store.init({
      goalStatement: "t",
      mode: "daily-triage",
      autonomy: { level: "L2", allowlistPaths: [], allowedCycleTypes: ["implement"], integrateAction: "propose", allowCodeWrite: true },
      budget: { limits: { maxTurnsPerCycle: 500, deadManMs: 1000, sameErrorRepeatLimit: 3, noProgressIterations: 3, noToolCallIterations: 2, reserveUsd: 0.1 }, usage: { iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, startedAt: new Date().toISOString() } },
    });
    // 模拟一个完成待批的 unit:建 worktree,写文件,commit
    const wt = ensureWorktree(root, "feat-x", "main");
    mkdirSync(join(wt.path, "src"), { recursive: true });
    writeFileSync(join(wt.path, "src/new.ts"), "export const v=1\n");
    commitAll(wt.path, "loop: feat-x");
    state.units.push({ id: "feat-x", title: "x", intent: "implement", status: "done", worktree: wt.path, dependsOn: [], cycles: [], attempts: 0 } as any);
    const escId = esc.escalate(state, { reason: "needs_input", unitId: "feat-x", humanQuestion: "批准?" });
    store.persist(state);

    // —— 模拟 `loop approve feat-x`(直接调底层逻辑)——
    const merge = mergeWorktree(rootBase(root), "feat-x", "main");
    expect(merge.merged).toBe(true);
    esc.resolve(escId, "approved");

    // base 上现在有 agent 写的文件
    expect(execSync("git show main:src/new.ts", { cwd: root }).toString()).toContain("export const v=1");
    // 决议已写回
    expect(esc.read(escId)!.resolution?.chosen).toBe("approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// mergeWorktree 需在主仓 root 跑
import { mergeWorktree } from "../src/worktree.ts";
function rootBase(root: string): string {
  return root;
}
