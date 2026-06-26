/**
 * daily-triage —— Phase 0 的 L1 模式。
 *
 * 只读扫描目标 repo(git status / 测试状态 / TODO / 依赖告警),
 * 产出 triage 报告 → 写 .loop/STATE.md。绝不改代码。
 *
 * allowCodeWrite=false 强制:用 opencode-runner 跑一个只读 prompt;
 * 即使 opencode 没跑成(无 model/网络),也用本地确定性扫描兜底,保证只读且可恢复。
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runSession, type RunResult } from "../opencode-runner.ts";

export type TriageReport = {
  scannedAt: string;
  target: string;
  gitStatus: string;
  recentCommits: string;
  todoCount: number;
  findings: string[];
  agentSummary: string | null;
};

function sh(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}

/** 本地确定性扫描(只读;不依赖 opencode)。 */
export function localScan(target: string): TriageReport {
  const gitStatus = sh("git status --porcelain", target);
  const recentCommits = sh("git log --oneline -10", target);
  const todoRaw = sh(
    "grep -rIl --exclude-dir=.git --exclude-dir=node_modules -e TODO -e FIXME .",
    target,
  );
  const todoCount = todoRaw ? todoRaw.split("\n").filter(Boolean).length : 0;

  const findings: string[] = [];
  if (gitStatus) findings.push(`工作区有 ${gitStatus.split("\n").length} 个未提交改动`);
  if (todoCount) findings.push(`${todoCount} 个文件含 TODO/FIXME`);
  if (!recentCommits) findings.push("无法读取 git 历史(可能非 git 仓库)");

  return {
    scannedAt: new Date().toISOString(),
    target,
    gitStatus,
    recentCommits,
    todoCount,
    findings,
    agentSummary: null,
  };
}

const READONLY_PROMPT = (target: string) =>
  `你是只读的日常巡检 agent。扫描仓库 ${target},用一段话总结当前健康状况:` +
  `未提交改动、最近提交趋势、潜在风险(TODO/FIXME 堆积、可疑文件)。` +
  `严禁修改任何文件、严禁运行任何写操作或破坏性命令。只读、只报告。`;

/**
 * 跑一次 triage。先本地扫描(保证有结果且只读),再可选用 opencode 补一段 AI 总结。
 * 返回 report + opencode 运行结果(供预算累加)。
 */
export async function runTriage(
  target: string,
  opts: { deadManMs: number; wallClockMs: number; model?: string | null; useAgent: boolean },
): Promise<{ report: TriageReport; run: RunResult | null }> {
  const report = localScan(target);
  let run: RunResult | null = null;

  if (opts.useAgent) {
    run = await runSession({
      prompt: READONLY_PROMPT(target),
      cwd: target,
      model: opts.model ?? null,
      deadManMs: opts.deadManMs,
      wallClockMs: opts.wallClockMs,
    });
    report.agentSummary = run.finalText;
  }

  return { report, run };
}

/** 写 .loop/STATE.md —— 人看的窗口。 */
export function writeStateMd(loopDir: string, report: TriageReport, extra: string): void {
  mkdirSync(loopDir, { recursive: true });
  const lines = [
    `# Loop STATE — daily triage`,
    ``,
    `> 扫描时间:${report.scannedAt}`,
    `> 目标:\`${report.target}\``,
    ``,
    `## 巡检发现`,
    report.findings.length ? report.findings.map((f) => `- ${f}`).join("\n") : "- 无异常",
    ``,
    `## 未提交改动`,
    report.gitStatus ? "```\n" + report.gitStatus + "\n```" : "_工作区干净_",
    ``,
    `## 最近提交`,
    report.recentCommits ? "```\n" + report.recentCommits + "\n```" : "_无_",
    ``,
    report.agentSummary ? `## AI 总结\n\n${report.agentSummary}` : "",
    ``,
    extra,
  ];
  writeFileSync(join(loopDir, "STATE.md"), lines.join("\n"), "utf8");
}
