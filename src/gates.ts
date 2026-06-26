/**
 * gates —— 跑验证门,产可审计证据 + negative control(反假收敛)。
 *
 * 来源:harness-audit rubric-template + verifier-protocol。
 * 每个 gate = 命令 + 期望阈值 + 原始输出 + verdict + negative control。
 * negative control 没 FAIL → verdict=invalid(不区分的坏温度计,不计入 pass)。
 */

import { execSync } from "node:child_process";
import type { Gate, GateVerdict } from "./schema/state.ts";
import { screenCommand } from "./safety.ts";

export type GateSpec = {
  id: string;
  criterion: string;
  command: string;
  /** 期望退出码(默认 0)。 */
  expectExit?: number;
  /** negative control:一个必然 FAIL 的命令,证明这个 check 能说 NO。 */
  negativeControl: { command: string };
  pillar?: number;
  fixCost?: "low" | "medium" | "high";
};

type RunOut = { exitCode: number; output: string };

function runCmd(command: string, cwd: string, timeoutMs: number): RunOut {
  try {
    const output = execSync(command, { cwd, stdio: "pipe", timeout: timeoutMs }).toString();
    return { exitCode: 0, output: output.slice(-4000) };
  } catch (e: any) {
    // 超时:execSync 抛 ETIMEDOUT,没有 status → 视作不可判定信号
    if (e.code === "ETIMEDOUT") return { exitCode: -1, output: `TIMEOUT after ${timeoutMs}ms` };
    const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    return { exitCode: typeof e.status === "number" ? e.status : 1, output: out.slice(-4000) };
  }
}

/**
 * 跑一个 gate,返回填充了 evidence + verdict 的 Gate 对象。
 *   - repo check 失败(exit≠expect)→ fail
 *   - repo check 通过 + negative control 没 FAIL → invalid(不区分)
 *   - repo check 通过 + negative control 如期 FAIL → pass
 *   - 命令超时/跑不起来 → uncheckable
 */
export function runGate(spec: GateSpec, cwd: string, timeoutMs = 120_000): Gate {
  const expectExit = spec.expectExit ?? 0;

  // 安全门(fail-closed):破坏性 gate 命令拒跑 → uncheckable(不可信)
  const safe = screenCommand(spec.command);
  const safeNeg = screenCommand(spec.negativeControl.command);
  if (!safe.safe || !safeNeg.safe) {
    const reason = safe.reason ?? safeNeg.reason;
    return {
      id: spec.id,
      criterion: spec.criterion,
      pillar: spec.pillar,
      command: spec.command,
      expect: `exit ${expectExit}`,
      negativeControl: { command: spec.negativeControl.command, expectFail: true },
      evidence: {
        rawOutput: `BLOCKED by safety gate: ${reason}`,
        measured: "blocked",
        exitCode: -2,
        ranAt: new Date().toISOString(),
        negativeControlFailed: false,
      },
      verdict: "uncheckable",
      fixCost: spec.fixCost,
    };
  }

  const main = runCmd(spec.command, cwd, timeoutMs);

  let verdict: GateVerdict;
  let negFailed = false;

  if (main.exitCode === -1) {
    // 超时 = 不可判定
    verdict = "uncheckable";
  } else {
    const repoPassed = main.exitCode === expectExit;
    if (!repoPassed) {
      verdict = "fail";
    } else {
      // negative control:必须 FAIL(exit ≠ expectExit)
      const neg = runCmd(spec.negativeControl.command, cwd, timeoutMs);
      negFailed = neg.exitCode !== expectExit;
      verdict = negFailed ? "pass" : "invalid";
    }
  }

  return {
    id: spec.id,
    criterion: spec.criterion,
    pillar: spec.pillar,
    command: spec.command,
    expect: `exit ${expectExit}`,
    negativeControl: { command: spec.negativeControl.command, expectFail: true },
    evidence: {
      rawOutput: main.output,
      measured: `exit ${main.exitCode}`,
      exitCode: main.exitCode,
      ranAt: new Date().toISOString(),
      negativeControlFailed: negFailed,
    },
    verdict,
    fixCost: spec.fixCost,
  };
}

export type GateResult = {
  verdict: "pass" | "fail" | "uncheckable" | "invalid";
  gates: Gate[];
  failing: Gate[];
};

/** 跑一组 gate。全 pass → pass;任一 invalid/uncheckable → 对应不可信 verdict;否则 fail。 */
export function runGates(specs: GateSpec[], cwd: string, timeoutMs?: number): GateResult {
  const gates = specs.map((s) => runGate(s, cwd, timeoutMs));
  const failing = gates.filter((g) => g.verdict !== "pass");
  let verdict: GateResult["verdict"] = "pass";
  if (gates.some((g) => g.verdict === "invalid")) verdict = "invalid";
  else if (gates.some((g) => g.verdict === "uncheckable")) verdict = "uncheckable";
  else if (gates.some((g) => g.verdict === "fail")) verdict = "fail";
  return { verdict, gates, failing };
}
