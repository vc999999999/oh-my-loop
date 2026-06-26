/**
 * 故障注入 — 机制层(test 4/6/7/8)。
 *   4. 验证命令超时:dead-man 杀进程 → cycle_partial
 *   6. out-of-scope 写:级联 + restoreFromSnapshot 回到 pre-run(不毁未提交工作)
 *   7. merge conflict:escalate(risky) 带结构化 diff
 *   8. verifier malformed:Zod 兜底偏 fail/invalid
 */

import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "../../src/opencode-runner.ts";
import { createSnapshotManager } from "../../src/snapshot.ts";
import { detectOutOfScope, revertCascade } from "../../src/scope.ts";
import { createJournal } from "../../src/journal.ts";
import { createEscalator } from "../../src/escalation.ts";
import { createStateStore } from "../../src/state-store.ts";
import { parseAndValidate, gateVerdictWithNegativeControl } from "../../src/verify.ts";

// ── test 4:dead-man 杀进程 ────────────────────────────────────────
test("4. 验证命令超时:dead-man 杀进程 → cycle_partial", async () => {
  // 假 child:永远不输出、永远不 close,直到被 kill。
  function fakeSpawn(): any {
    const child: any = new EventEmitter();
    child.stdout = new Readable({ read() {} }); // 永不 push
    child.stderr = new Readable({ read() {} });
    child.kill = () => {
      child.stdout.push(null);
      child.stderr.push(null);
      setImmediate(() => child.emit("close", null));
      return true;
    };
    return child;
  }
  const r = await runSession({
    prompt: "hang",
    cwd: "/tmp",
    deadManMs: 100, // 100ms 静默就杀
    wallClockMs: 10_000,
    spawnImpl: fakeSpawn as any,
  });
  expect(r.killedBy).toBe("deadman");
  expect(r.signal).toBe("cycle_partial");
});

// ── test 6:scope 越界 + snapshot 回滚 ─────────────────────────────
test("6. out-of-scope 写:回滚到 pre-run 内容(不毁未提交工作)", () => {
  const root = mkdtempSync(join(tmpdir(), "scope-test-"));
  try {
    execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: root });
    // 已提交基线
    writeFileSync(join(root, "owned.ts"), "committed\n");
    execSync("git add -A && git commit -qm base", { cwd: root });
    // 用户的未提交工作(关键:回滚不能毁这个)
    writeFileSync(join(root, "owned.ts"), "USER UNCOMMITTED WORK\n");

    const snap = createSnapshotManager({ snapshotDir: join(root, ".loop/snapshot"), root });
    snap.createPreRunSnapshot(); // 抓住未提交内容

    // agent 越界:改了 owned.ts(scope 外)+ 新建 stray.ts(scope 外)
    writeFileSync(join(root, "owned.ts"), "AGENT CLOBBERED IT\n");
    writeFileSync(join(root, "stray.ts"), "agent created this\n");

    const scope = ["src/"]; // 只允许写 src/
    const changed = ["owned.ts", "stray.ts"];
    const outOfScope = detectOutOfScope(changed, scope);
    expect(outOfScope.sort()).toEqual(["owned.ts", "stray.ts"]);

    const results = revertCascade(root, outOfScope, snap);
    // owned.ts 回到用户未提交内容(快照),不是 HEAD 的 "committed"
    expect(readFileSync(join(root, "owned.ts"), "utf8")).toBe("USER UNCOMMITTED WORK\n");
    expect(results.find((r) => r.file === "owned.ts")?.via).toBe("snapshot");
    // stray.ts(快照没有它)被 git-clean 删掉
    expect(existsSync(join(root, "stray.ts"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── test 7:merge conflict → 结构化 escalate(risky) ───────────────
test("7. merge conflict:escalate(risky) 带结构化 diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "esc-test-"));
  try {
    const journal = createJournal(dir);
    const escalator = createEscalator(dir, journal);
    const store = createStateStore(dir);
    const state = store.init({
      goalStatement: "t",
      mode: "daily-triage",
      autonomy: { level: "L1", allowlistPaths: [], allowedCycleTypes: ["explore"], integrateAction: "none", allowCodeWrite: false },
      budget: { limits: { maxTurnsPerCycle: 500, deadManMs: 1000, sameErrorRepeatLimit: 3, noProgressIterations: 3, noToolCallIterations: 2, reserveUsd: 0.1 }, usage: { iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, startedAt: new Date().toISOString() } },
    });
    const id = escalator.escalate(state, {
      reason: "risky",
      unitId: "u1",
      humanQuestion: "integrate 合并冲突,需人解决",
      risk: "high",
      diffSummary: "src/a.ts: CONFLICT (both modified)",
      failingCommands: [{ command: "git merge", exitCode: 1, output: "CONFLICT (content): Merge conflict in src/a.ts" }],
    });
    const esc = JSON.parse(readFileSync(join(dir, "escalations", `${id}.json`), "utf8"));
    expect(esc.reason).toBe("risky");
    expect(esc.risk).toBe("high");
    expect(esc.diffSummary).toContain("CONFLICT");
    expect(esc.failingCommands[0].exitCode).toBe(1);
    expect(state.escalationIds).toContain(id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── test 8:verifier malformed → 保守默认偏 fail/invalid ───────────
test("8. verifier malformed:Zod 兜底偏 invalid", () => {
  // 非法 JSON
  const r1 = parseAndValidate("{ not json");
  expect(r1.valid).toBe(false);
  expect((r1 as any).fallback.verdict).toBe("invalid");

  // schema 不符(verdict 不是合法枚举)
  const r2 = parseAndValidate(JSON.stringify({ verdict: "definitely-passed" }));
  expect(r2.valid).toBe(false);
  expect((r2 as any).fallback.verdict).toBe("invalid");

  // negative control 没 FAIL → check 不区分 → invalid(不计入 pass)
  expect(gateVerdictWithNegativeControl(true, false)).toBe("invalid");
  expect(gateVerdictWithNegativeControl(true, true)).toBe("pass");
  expect(gateVerdictWithNegativeControl(false, true)).toBe("fail");
});
