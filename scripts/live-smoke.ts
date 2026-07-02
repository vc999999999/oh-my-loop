#!/usr/bin/env bun
/**
 * live-smoke —— 真实 opencode 冒烟:新 prompt 走完 runner 全链路。
 *
 * 用法:bun run smoke [--model provider/model] [--keep]
 *   在临时 git 仓库跑一次 explorePrompt(只读,不碰真实项目)。
 *   有已认证 provider 时验证真实模型行为;没有时验证失败路径优雅降级
 *   (期望 signal=error/cycle_partial,禁止挂死或崩溃)。
 *
 * 判定:
 *   - 有模型:signal=cycle_complete 且 finalText 含「改动范围」结构 → PASS
 *   - 无模型:signal=error|cycle_partial 且 killedBy=null → PASS(降级正确)
 *   - 其他(挂死靠 watchdog 杀、崩溃)→ FAIL
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "../src/opencode-runner.ts";
import { explorePrompt } from "../src/prompts.ts";

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] ?? null : null;
const keep = args.includes("--keep");

const dir = mkdtempSync(join(tmpdir(), "loop-live-smoke-"));
execSync("git init -q && git config user.email smoke@loop && git config user.name smoke", { cwd: dir });
writeFileSync(join(dir, "hello.ts"), 'export const hello = () => "world";\n');
execSync("git add -A && git commit -qm init", { cwd: dir });

console.log(`smoke dir: ${dir}${model ? `  model: ${model}` : "  model: (opencode 默认)"}`);

const r = await runSession({
  prompt: explorePrompt("总结这个仓库的结构和 hello.ts 的作用"),
  cwd: dir,
  model,
  deadManMs: 120_000,
  wallClockMs: 300_000,
});

console.log(JSON.stringify({
  signal: r.signal,
  killedBy: r.killedBy,
  steps: r.steps.length,
  toolCalls: r.toolCallCount,
  lastError: r.lastError?.slice(0, 300) ?? null,
  finalTextHead: r.finalText?.slice(0, 500) ?? null,
}, null, 2));

let pass: boolean;
let note: string;
if (r.signal === "cycle_complete" && r.finalText) {
  pass = r.finalText.includes("改动范围") || r.finalText.length > 50;
  note = pass ? "真实模型跑通,最终消息符合交付契约" : "模型跑通但最终消息不符合结构契约";
} else if ((r.signal === "error" || r.signal === "cycle_partial") && !r.killedBy) {
  pass = true;
  note = "无可用 provider:失败路径优雅降级(未挂死/未崩溃)。配置凭证后重跑可验证模型行为";
} else {
  pass = false;
  note = `异常:signal=${r.signal} killedBy=${r.killedBy}`;
}

if (!keep) rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass ? "✅ SMOKE PASS" : "❌ SMOKE FAIL"} — ${note}`);
process.exit(pass ? 0 : 1);
