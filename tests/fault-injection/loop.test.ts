/**
 * 故障注入 — loop 层(test 1/2/3/5)。
 *   1. kill-9 恢复:重启从 state 续,不重做已完成 cycle
 *   2. 损坏 state:备份 + escalate,不静默
 *   3. 预算耗尽:escalate(budget)
 *   5. 同错误重复:circuit breaker → escalate(stuck)
 */

import { test, expect } from "bun:test";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runController } from "../../src/controller.ts";
import { createStateStore } from "../../src/state-store.ts";
import { tmpLoopDir, testConfig, testMode, complete } from "./helpers.ts";
import type { CycleOutcome } from "../../src/controller.ts";

test("1. kill-9 恢复:resume 不重做已完成 cycle", async () => {
  const { dir, cleanup } = tmpLoopDir();
  try {
    const config = testConfig(dir);
    // 第一次:loop0 = plan + cycle a(同轮),loop1 = cycle b,maxLoops=2 → halt 在 c 之前
    const mode1 = testMode(["a", "b", "c"], () => complete());
    const r1 = await runController(config, mode1, { maxLoops: 2 });
    expect(r1.outcome).toBe("halted");
    expect(mode1.runs).toEqual({ a: 1, b: 1 }); // c 还没跑

    // 模拟 kill-9:进程没了,只剩 .loop/state.json。新进程 resume。
    const mode2 = testMode(["a", "b", "c"], () => complete());
    const r2 = await runController(config, mode2);
    expect(r2.outcome).toBe("done");
    // ★ 关键:a/b 不重做,只跑 c
    expect(mode2.runs).toEqual({ c: 1 });
  } finally {
    cleanup();
  }
});

test("2. 损坏 state:备份 + escalate,不静默续跑", async () => {
  const { dir, cleanup } = tmpLoopDir();
  try {
    const config = testConfig(dir);
    // 先正常 init 一个 state
    await runController(config, testMode(["a"], () => complete()), { maxLoops: 1 });
    // 损坏它
    writeFileSync(join(dir, "state.json"), "{ this is not valid json ", "utf8");

    const r = await runController(config, testMode(["a"], () => complete()));
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("corrupt_state");
    // 备份文件存在
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    // escalation 写了
    expect(existsSync(join(dir, "escalations"))).toBe(true);
    expect(readdirSync(join(dir, "escalations")).length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("3. 预算耗尽:cost 超限 → escalate(budget)", async () => {
  const { dir, cleanup } = tmpLoopDir();
  try {
    const config = testConfig(dir, { budget: { ...testConfig(dir).budget, maxCostUsd: 1, reserveUsd: 0 } as any });
    // cycle a 返回一个 $5 的 step → 下一轮顶部 costIs 命中
    const expensive = (): CycleOutcome => ({
      signal: "cycle_complete",
      steps: [{ costUsd: 5, tokens: null }],
      toolCallCount: 0,
      finalText: "spent",
      lastError: null,
      ranAgent: false,
    });
    const r = await runController(config, testMode(["a", "b"], () => expensive()));
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("cost");
  } finally {
    cleanup();
  }
});

test("5. 同错误重复:sameError → escalate(stuck)", async () => {
  const { dir, cleanup } = tmpLoopDir();
  try {
    const config = testConfig(dir, {
      budget: { ...testConfig(dir).budget, sameErrorRepeatLimit: 3 } as any,
    });
    // cycle a 永远 partial 同一个错误;maxAttempts 拉高,让 sameError 先于 retries_exhausted 触发
    const sameErr = (): CycleOutcome => ({
      signal: "cycle_partial",
      steps: [],
      toolCallCount: 0,
      finalText: null,
      lastError: "boom: the same error at /x/y.ts:42",
      ranAgent: false,
    });
    const mode = testMode(["a"], () => sameErr());
    // 把 maxAttempts 改高:通过自定义 planUnit
    mode.planUnit = () =>
      ({
        id: "u1",
        title: "t",
        intent: "fix",
        status: "pending",
        dependsOn: [],
        attempts: 0,
        cycles: [{ id: "a", type: "explore", status: "pending", owner: null, parallel: false, scope: [], consumesOutputOf: [], attempts: 0, maxAttempts: 99, gates: [] }],
      }) as any;
    const r = await runController(config, mode);
    expect(r.outcome).toBe("escalated");
    expect(r.reason).toBe("same_error");
  } finally {
    cleanup();
  }
});

test("state.json 始终 schema-valid(每轮原子写)", async () => {
  const { dir, cleanup } = tmpLoopDir();
  try {
    const config = testConfig(dir);
    await runController(config, testMode(["a", "b"], () => complete()));
    const store = createStateStore(dir);
    const loaded = store.load();
    expect(loaded.kind).toBe("loaded");
  } finally {
    cleanup();
  }
});
