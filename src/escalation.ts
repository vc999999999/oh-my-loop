/**
 * escalation —— 结构化交人 + 去重/聚合(F3)。
 *
 * 来源:loop-engineering escalate-with-context + cortex human-answers + Plannotator。
 * 固定生成 .loop/escalations/<id>.json(schema Escalation),更新 state.escalationIds。
 * 去重:同 fingerprint(reason + 归一化 error)的未解决升级,合并成一条带 affectedUnits[],
 *       不再刷屏。来自 optimization-review O7。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Escalation,
  type Escalation as EscalationT,
  type EscalationReason,
  type LoopState_File,
} from "./schema/state.ts";
import { errorFingerprint } from "./progress.ts";
import { createHash } from "node:crypto";
import type { Journal } from "./journal.ts";
import type { Notifier } from "./notify.ts";

export type EscalateArgs = {
  reason: EscalationReason;
  unitId?: string | null;
  cycleId?: string | null;
  attempts?: number;
  lastError?: string;
  failingCommands?: { command: string; exitCode: number; output: string }[];
  diffSummary?: string;
  risk?: "low" | "medium" | "high";
  recommendedOptions?: { label: string; detail: string; recommended?: boolean }[];
  humanQuestion: string;
  /** 预算/卡住型熔断的现场快照(reason=budget/stuck_no_progress 时填)。 */
  stopContext?: {
    firedPredicate: string;
    iteration: number;
    tokens: number;
    costUsd: number;
    wallClockMs: number;
    recentErrors?: string[];
    recentProgress?: string[];
  };
};

export function createEscalator(loopDir: string, journal: Journal, notify?: Notifier) {
  const escDir = join(loopDir, "escalations");

  function fingerprintOf(args: EscalateArgs): string {
    return createHash("sha1")
      .update(`${args.reason}|${errorFingerprint(args.lastError)}`)
      .digest("hex")
      .slice(0, 12);
  }

  /** 找一条同 fingerprint 且未解决的现有 escalation(用于聚合)。 */
  function findOpenByFingerprint(fp: string): EscalationT | null {
    if (!existsSync(escDir)) return null;
    for (const f of readdirSync(escDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = Escalation.parse(JSON.parse(readFileSync(join(escDir, f), "utf8")));
        if (e.fingerprint === fp && !e.resolution) return e;
      } catch {
        /* 跳过坏文件 */
      }
    }
    return null;
  }

  function write(esc: EscalationT): void {
    mkdirSync(escDir, { recursive: true });
    writeFileSync(join(escDir, `${esc.id}.json`), JSON.stringify(esc, null, 2), "utf8");
  }

  /** 写一条 escalation(去重)。同指纹未解决 → 聚合进现有那条。返回 escalation id。 */
  function escalate(state: LoopState_File, args: EscalateArgs): string {
    const fp = fingerprintOf(args);
    const existing = findOpenByFingerprint(fp);

    if (existing) {
      // 聚合:加 affectedUnits、occurrences++,不新建文件,也不重复加进 escalationIds
      if (args.unitId && !existing.affectedUnits.includes(args.unitId)) {
        existing.affectedUnits.push(args.unitId);
      }
      existing.occurrences += 1;
      write(existing);
      state.state = "escalate";
      journal.append({
        event: "escalation_merged",
        state: "escalate",
        reason: args.reason,
        unit: args.unitId ?? null,
        detail: { id: existing.id, occurrences: existing.occurrences, fingerprint: fp },
      });
      return existing.id;
    }

    const id = `esc-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    const esc: EscalationT = Escalation.parse({
      id,
      createdAt: new Date().toISOString(),
      reason: args.reason,
      unitId: args.unitId ?? null,
      cycleId: args.cycleId ?? null,
      attempts: args.attempts ?? 0,
      lastError: args.lastError,
      failingCommands: args.failingCommands ?? [],
      diffSummary: args.diffSummary,
      risk: args.risk ?? "medium",
      recommendedOptions: (args.recommendedOptions ?? []).map((o) => ({
        label: o.label,
        detail: o.detail,
        recommended: o.recommended ?? false,
      })),
      humanQuestion: args.humanQuestion,
      fingerprint: fp,
      affectedUnits: args.unitId ? [args.unitId] : [],
      occurrences: 1,
      stopContext: args.stopContext,
    });
    write(esc);
    state.escalationIds.push(id);
    state.state = "escalate";
    journal.append({
      event: "escalated",
      state: "escalate",
      reason: args.reason,
      unit: args.unitId ?? null,
      cycle: args.cycleId ?? null,
      detail: { id, humanQuestion: args.humanQuestion, fingerprint: fp },
    });
    // 真·报警:只对新建 escalation 发(聚合那条故意不发,避免刷屏)。best-effort。
    if (notify) {
      try {
        notify({
          id,
          reason: args.reason,
          risk: args.risk ?? "medium",
          humanQuestion: args.humanQuestion,
          unitId: args.unitId ?? null,
          loopDir,
        });
      } catch {
        /* 告警失败绝不拖垮主 loop */
      }
    }
    return id;
  }

  /** 读一条 escalation。 */
  function read(id: string): EscalationT | null {
    const p = join(escDir, `${id}.json`);
    if (!existsSync(p)) return null;
    try {
      return Escalation.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return null;
    }
  }

  /** 写回人类决议(F4 批准/驳回闭环用)。 */
  function resolve(id: string, chosen: string, note?: string): EscalationT | null {
    const esc = read(id);
    if (!esc) return null;
    esc.resolution = { answeredAt: new Date().toISOString(), chosen, note };
    write(esc);
    journal.append({ event: "escalation_resolved", detail: { id, chosen } });
    return esc;
  }

  return { escalate, read, resolve, escDir };
}

export type Escalator = ReturnType<typeof createEscalator>;
