/**
 * 测试:ROI/采纳率聚合 + escalation 告警(Notify)。
 *
 * 用真实写入路径(createEscalator + createJournal)造数据,再 computeRoi 断言,
 * 同时验证 notify 只对「新建」escalation 触发、对「聚合」不触发(不刷屏)。
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEscalator } from "../src/escalation.ts";
import { createJournal } from "../src/journal.ts";
import { computeRoi } from "../src/roi.ts";
import type { NotifyPayload } from "../src/notify.ts";

/** escalate() 只用到 state.escalationIds / state.state,给个最小桩。 */
function stubState(): any {
  return { escalationIds: [], state: "triage" };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("ROI:采纳率 50% → healthy,自动合并/只读分别计数", () => {
  const dir = tmp("roi-");
  try {
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal);
    const st = stubState();
    // 两条不同指纹的 escalation(reason 不同 → 不聚合),一批一驳
    const a = esc.escalate(st, { reason: "needs_input", lastError: "errA", humanQuestion: "qa" });
    const b = esc.escalate(st, { reason: "retries_exhausted", lastError: "errB", humanQuestion: "qb" });
    esc.resolve(a, "approved");
    esc.resolve(b, "rejected");
    // journal:一条自动合并(L3)、一条只读(L1)
    journal.append({ event: "unit_done", unit: "u1", detail: { integrate: "merged" } });
    journal.append({ event: "unit_done", unit: "u2", detail: { integrate: "recorded" } });

    const r = computeRoi(dir);
    expect(r.approved).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.decided).toBe(2);
    expect(r.pending).toBe(0);
    expect(r.acceptRate).toBeCloseTo(0.5, 5);
    expect(r.autoMerged).toBe(1);
    expect(r.recorded).toBe(1);
    expect(r.verdict).toBe("healthy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROI:采纳率 <50% → lossmaking", () => {
  const dir = tmp("roi2-");
  try {
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal);
    const st = stubState();
    const a = esc.escalate(st, { reason: "needs_input", lastError: "e1", humanQuestion: "q" });
    const b = esc.escalate(st, { reason: "retries_exhausted", lastError: "e2", humanQuestion: "q" });
    const c = esc.escalate(st, { reason: "risky", lastError: "e3", humanQuestion: "q" });
    esc.resolve(a, "approved");
    esc.resolve(b, "rejected");
    esc.resolve(c, "rejected");

    const r = computeRoi(dir);
    expect(r.acceptRate).toBeCloseTo(1 / 3, 5);
    expect(r.verdict).toBe("lossmaking");
    expect(r.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROI:无数据 → insufficient_data", () => {
  const dir = tmp("roi3-");
  try {
    const r = computeRoi(dir);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.acceptRate).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Notify:新建 escalation 触发告警,聚合不触发", () => {
  const dir = tmp("notify-");
  try {
    const calls: NotifyPayload[] = [];
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal, (p) => calls.push(p));
    const st = stubState();
    // 同 reason + 同 lastError → 同指纹:第一条新建(发),第二条聚合(不发)
    esc.escalate(st, { reason: "budget", lastError: "same", humanQuestion: "q1", unitId: "u1", risk: "high" });
    esc.escalate(st, { reason: "budget", lastError: "same", humanQuestion: "q2", unitId: "u2" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toBe("budget");
    expect(calls[0]!.risk).toBe("high");
    expect(calls[0]!.unitId).toBe("u1");
    expect(calls[0]!.loopDir).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Notify:notifier 抛错不影响 escalate", () => {
  const dir = tmp("notify2-");
  try {
    const journal = createJournal(dir);
    const esc = createEscalator(dir, journal, () => {
      throw new Error("webhook down");
    });
    const st = stubState();
    // 不应抛:notify 失败被隔离
    const id = esc.escalate(st, { reason: "budget", humanQuestion: "q" });
    expect(id).toBeTruthy();
    expect(st.escalationIds).toContain(id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
