/**
 * reviewer —— 独立 checker(maker/checker 分离)。
 *
 * 来源:Superpowers(干活的 agent 无权宣布成功)+ harness-audit verifier-protocol。
 * 隔离铁律:checker 只收到 repo 路径 + 验收 criterion + 改动文件列表;
 *   绝不收到 maker 的 session / 推理 / 对话 —— 否则退化成「带额外步骤的自我批评」。
 * 实现:起一个全新 opencode session(不 --continue/--session),用 verifier prompt,
 *   要求输出 JSON {verdict, ...},再用 verify.parseAndValidate Zod 兜底(坏输出偏 invalid)。
 */

import { runSession } from "./opencode-runner.ts";
import { parseAndValidate } from "./verify.ts";
import { verifierPrompt } from "./prompts.ts";
import type { CycleOutcome } from "./controller.ts";

export type ReviewArgs = {
  workdir: string;
  criterion: string;
  changedFiles: string[];
  model?: string | null;
  /** 受限 checker agent(工具级只读);不配则 opencode 默认 agent + prompt 软约束。 */
  agent?: string | null;
  deadManMs: number;
  wallClockMs: number;
};

/** 默认 reviewer:全新 session 跑 verifier(prompt 见 prompts.verifierPrompt),Zod 兜底解析 verdict。 */
export async function defaultReviewer(args: ReviewArgs): Promise<CycleOutcome> {
  const run = await runSession({
    prompt: verifierPrompt(args.criterion, args.changedFiles),
    cwd: args.workdir,
    sessionId: null, // ★ 全新 session:与 maker 的上下文物理隔离
    model: args.model ?? null,
    agent: args.agent ?? null,
    deadManMs: args.deadManMs,
    wallClockMs: args.wallClockMs,
  });

  if (run.signal === "error" || !run.finalText) {
    return { signal: "cycle_partial", steps: run.steps, toolCallCount: run.toolCallCount, finalText: null, lastError: run.lastError ?? "reviewer no output", ranAgent: true };
  }

  // 从输出里抠出最后一个 JSON 对象
  const jsonText = extractLastJson(run.finalText);
  const parsed = parseAndValidate(jsonText ?? "");
  const verdict = parsed.valid ? parsed.data.verdict : parsed.fallback.verdict;

  if (verdict === "pass") {
    return { signal: "cycle_complete", steps: run.steps, toolCallCount: run.toolCallCount, finalText: "reviewer: pass", lastError: null, ranAgent: true };
  }
  // fail / invalid / uncheckable → partial(回边重做)或不可信
  return {
    signal: "cycle_partial",
    steps: run.steps,
    toolCallCount: run.toolCallCount,
    finalText: null,
    lastError: `reviewer verdict=${verdict}`,
    ranAgent: true,
  };
}

function extractLastJson(text: string): string | null {
  const matches = text.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  return matches ? matches[matches.length - 1]! : null;
}
