/**
 * escalation —— 结构化交人。
 *
 * 来源:loop-engineering escalate-with-context + cortex human-answers + Plannotator。
 * 固定生成 .loop/escalations/<id>.json(schema Escalation),更新 state.escalationIds。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Escalation,
  type Escalation as EscalationT,
  type EscalationReason,
  type LoopState_File,
} from "./schema/state.ts";
import type { Journal } from "./journal.ts";

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
};

export function createEscalator(loopDir: string, journal: Journal) {
  const escDir = join(loopDir, "escalations");

  /** 写一条 escalation,挂到 state 上,journal 记录。返回 escalation id。 */
  function escalate(state: LoopState_File, args: EscalateArgs): string {
    mkdirSync(escDir, { recursive: true });
    const id = `esc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
    });
    writeFileSync(join(escDir, `${id}.json`), JSON.stringify(esc, null, 2), "utf8");
    state.escalationIds.push(id);
    state.state = "escalate";
    journal.append({
      event: "escalated",
      state: "escalate",
      reason: args.reason,
      unit: args.unitId ?? null,
      cycle: args.cycleId ?? null,
      detail: { id, humanQuestion: args.humanQuestion },
    });
    return id;
  }

  return { escalate, escDir };
}

export type Escalator = ReturnType<typeof createEscalator>;
