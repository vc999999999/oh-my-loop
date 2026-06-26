/**
 * opencode-runner —— spawn `opencode run --format json` 并解析事件流。
 *
 * 集成接口 live 确认(cortex opencode-adapter + opencode run --help):
 *   - `opencode run "<prompt>" --format json` 输出逐行 JSON 事件。
 *   - 事件:step_start / text / tool_use / step_finish{tokens,cost} / error。
 *   - cost/tokens 每个 step_finish 都有,无总计 → 累加。
 *   - opencode run 无 maxTurns/budget/timeout 标志 → 外层杀进程强制(dead-man/wallclock)。
 *   - --dir = worktree;--session = 恢复;--agent = maker/checker(Phase 1+)。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { OpenCodeTokens } from "./budget.ts";

export type RunSignal = "cycle_complete" | "cycle_partial" | "needs_human_input" | "error";

export type StepUsage = { costUsd: number | null; tokens: OpenCodeTokens | null };

export type RunResult = {
  signal: RunSignal;
  sessionId: string | null;
  /** 每个 step_finish 的用量,交给 budget.accumulate。 */
  steps: StepUsage[];
  toolCallCount: number;
  finalText: string | null;
  lastError: string | null;
  killedBy: "deadman" | "wallclock" | null;
};

export type RunOptions = {
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  /** 每收到事件刷新一次;静默超过此值杀进程(dead-man)。 */
  deadManMs: number;
  /** 整轮墙钟上限。 */
  wallClockMs: number;
  /** 可选:每收到一个 step_finish 回调(让控制器实时累加预算/刷新 lastOutputAt)。 */
  onStep?: (u: StepUsage) => void;
  /** 注入用的 spawn 实现(测试可替换);默认 node child_process.spawn。 */
  spawnImpl?: typeof spawn;
};

/**
 * extractResult —— 把一条 opencode 事件规整成我们关心的形状。
 * 事件 schema 直接照搬 cortex opencode-adapter.mjs:201(live 确认)。
 */
function extractEvent(ev: any):
  | { kind: "text"; text: string | null }
  | { kind: "tool" }
  | { kind: "turn"; costUsd: number | null; tokens: OpenCodeTokens | null; reason: string | null }
  | { kind: "error"; message: string }
  | null {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "text") return { kind: "text", text: (ev.part?.text ?? "").trim() || null };
  if (ev.type === "tool_use") return { kind: "tool" };
  if (ev.type === "step_finish") {
    const part = ev.part ?? {};
    return {
      kind: "turn",
      costUsd: typeof part.cost === "number" ? part.cost : null,
      tokens: (part.tokens ?? null) as OpenCodeTokens | null,
      reason: part.reason ?? null,
    };
  }
  if (ev.type === "error") {
    const msg = ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? "Unknown provider error";
    return { kind: "error", message: String(msg) };
  }
  return null;
}

export async function runSession(opts: RunOptions): Promise<RunResult> {
  const args = ["run", opts.prompt, "--format", "json"];
  if (opts.cwd) args.push("--dir", opts.cwd);
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.model) args.push("--model", opts.model);

  const doSpawn = opts.spawnImpl ?? spawn;
  const child = doSpawn("opencode", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

  const result: RunResult = {
    signal: "cycle_complete",
    sessionId: opts.sessionId ?? null,
    steps: [],
    toolCallCount: 0,
    finalText: null,
    lastError: null,
    killedBy: null,
  };

  let lastOutput = Date.now();
  const started = Date.now();

  // 外层熔断:dead-man(静默超时) + wallclock(整轮超时)。opencode run 自己没有这些。
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastOutput >= opts.deadManMs) {
      result.killedBy = "deadman";
      child.kill("SIGKILL");
    } else if (now - started >= opts.wallClockMs) {
      result.killedBy = "wallclock";
      child.kill("SIGKILL");
    }
  }, 1_000);

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    lastOutput = Date.now();
    const ev = extractEvent(safeParse(line));
    if (!ev) return;
    if (ev.kind === "text") {
      if (ev.text) result.finalText = ev.text;
    } else if (ev.kind === "tool") {
      result.toolCallCount++;
    } else if (ev.kind === "turn") {
      const step: StepUsage = { costUsd: ev.costUsd, tokens: ev.tokens };
      result.steps.push(step);
      opts.onStep?.(step);
    } else if (ev.kind === "error") {
      result.lastError = ev.message;
      result.signal = "error";
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => {
    lastOutput = Date.now();
    stderr += d.toString();
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (e) => {
      result.lastError = e.message;
      result.signal = "error";
      resolve(1);
    });
  });

  clearInterval(watchdog);

  // 被外层杀掉 → partial(turn cap/超时语义),记 killedBy。
  if (result.killedBy) {
    result.signal = "cycle_partial";
    result.lastError = result.lastError ?? `killed by ${result.killedBy}`;
  } else if (result.signal !== "error") {
    // 0 step + 无文本 = 静默失败(cortex 同款判定)→ partial。
    if (result.steps.length === 0 && !result.finalText) {
      result.signal = "cycle_partial";
      result.lastError = stderr.trim().slice(-500) || "0-turn silent failure";
    } else if (exitCode !== 0) {
      result.signal = "cycle_partial";
      result.lastError = stderr.trim().slice(-500) || `exit ${exitCode}`;
    }
  }

  return result;
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export { extractEvent as _extractEvent };
