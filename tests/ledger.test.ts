/**
 * F1 测试:跨会话预算账本 + 阈值告警。
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/ledger.ts";
import type { BudgetUsage } from "../src/schema/state.ts";

function usage(over: Partial<BudgetUsage>): BudgetUsage {
  return {
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    ...over,
  };
}

test("账本跨 run 累计", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledg-"));
  try {
    const l = createLedger(dir);
    l.record("g1", "done", usage({ iterations: 3, inputTokens: 1000, outputTokens: 50, costUsd: 0.5 }));
    l.record("g1", "escalated", usage({ iterations: 2, inputTokens: 500, outputTokens: 20, costUsd: 0.3 }));
    const t = l.totals();
    expect(t.runs).toBe(2);
    expect(t.iterations).toBe(5);
    expect(t.inputTokens).toBe(1500);
    expect(t.costUsd).toBeCloseTo(0.8, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("阈值告警:累计超过即触发", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledg2-"));
  try {
    const l = createLedger(dir);
    l.record("g1", "done", usage({ costUsd: 1.2, inputTokens: 9000, outputTokens: 2000 }));
    expect(l.checkThresholds({ totalCostUsd: 1.0 })).toHaveLength(1);
    expect(l.checkThresholds({ totalCostUsd: 5.0 })).toHaveLength(0);
    expect(l.checkThresholds({ totalTokens: 10000 })).toHaveLength(1); // 11000 ≥ 10000
    expect(l.checkThresholds({ totalTokens: 20000 })).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空账本 totals 全 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledg3-"));
  try {
    const t = createLedger(dir).totals();
    expect(t).toEqual({ runs: 0, iterations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
