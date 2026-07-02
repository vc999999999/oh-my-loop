#!/usr/bin/env bun
/**
 * e2e-live —— 真实 opencode 全链路验收:explore → implement → verify → integrate(L3)。
 *
 * 用法:bun run e2e [--keep]
 *   在临时 git 仓库跑完整 task 流水线,预算按慢网络放宽
 *   (cli.ts 的默认 15min 总墙钟在 provider 慢时不够,见 design/prompt-conduct.md)。
 *
 * 判定(全部满足才 PASS):
 *   - outcome=done
 *   - L3 auto-merge 后目标仓库 main 上 add(2,3)===5 且 hello()==="world"
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runController } from "../src/controller.ts";
import { createTaskMode } from "../src/modes/task-mode.ts";
import type { LoopConfig } from "../loop.config.ts";
import { stderrNotifier } from "../src/notify.ts";

const keep = process.argv.includes("--keep");

const root = mkdtempSync(join(tmpdir(), "loop-e2e-live-"));
execSync("git init -q -b main && git config user.email e2e@loop && git config user.name e2e", { cwd: root });
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src/hello.ts"), 'export const hello = () => "world";\n');
execSync("git add -A && git commit -qm init", { cwd: root });
console.log(`e2e repo: ${root}`);

const config: LoopConfig = {
  target: root,
  loopDir: join(root, ".loop"),
  mode: "daily-triage",
  isolate: true,
  baseBranch: "main",
  autonomy: { level: "L3", allowCodeWrite: true, integrateAction: "auto", allowlistPaths: ["src/"] },
  // 慢网络预算:总墙钟 45min,单 cycle 静默 10min 熔断
  budget: {
    maxIterations: 20,
    maxCostUsd: 2.0,
    maxWallClockMs: 45 * 60_000,
    deadManMs: 10 * 60_000,
    sameErrorRepeatLimit: 4,
    noProgressIterations: 6,
    noToolCallIterations: 4,
  },
  gates: [
    {
      id: "add-works",
      criterion: "add(2,3)===5 且 hello 未被改动",
      command: `bun -e 'import {add,hello} from "./src/hello.ts"; if (add(2,3)!==5||hello()!=="world") throw new Error("gate fail")'`,
      negativeControl: { command: "false" },
    },
  ],
  notify: stderrNotifier,
};

const mode = createTaskMode({
  id: `e2e-${Date.now()}`,
  title: "e2e: add()",
  instruction: "在 src/hello.ts 中新增并导出函数 add(a: number, b: number): number,返回 a+b。不要改动 hello 函数。",
  scope: ["src/"],
});

const r = await runController(config, mode);
console.log(`\noutcome=${r.outcome} reason=${r.reason ?? ""} iterations=${r.state.budget.usage.iterations}`);

let pass = r.outcome === "done";
let note = pass ? "流水线 done" : `流水线未完成:${r.outcome}/${r.reason}`;
if (pass) {
  // L3 auto-merge 后,验证 main 上的最终产物
  try {
    execSync(`bun -e 'import {add,hello} from "${root}/src/hello.ts"; if (add(2,3)!==5||hello()!=="world") throw new Error("bad")'`, { stdio: "pipe" });
    note = "全链路 done + main 上产物验证通过(add(2,3)=5, hello 未动)";
  } catch {
    pass = false;
    note = "流水线 done 但 main 上产物验证失败";
  }
}

if (!keep) rmSync(root, { recursive: true, force: true });
console.log(`\n${pass ? "✅ E2E PASS" : "❌ E2E FAIL"} — ${note}`);
process.exit(pass ? 0 : 1);
