#!/usr/bin/env bun
/**
 * cli —— loop run / resume / status。
 *
 * run    : 从 config 起一轮 loop(不存在 state 则 init)。
 * resume : 等价于 run —— load 已有 state 续跑(状态外化决定了 run/resume 同源)。
 * status : 打印 .loop/STATE.md + 预算用量。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import defaultConfig, { type LoopConfig } from "../loop.config.ts";
import { runController } from "./controller.ts";
import { createDailyTriageMode } from "./modes/daily-triage-mode.ts";
import { createTaskMode } from "./modes/task-mode.ts";
import { createStateStore } from "./state-store.ts";
import type { GateSpec } from "./gates.ts";

function loadConfig(): LoopConfig {
  // Phase 0:直接用 loop.config.ts 默认值(env LOOP_TARGET 可覆盖 target)。
  return defaultConfig;
}

async function cmdRun(): Promise<number> {
  const config = loadConfig();
  const mode = createDailyTriageMode();
  const result = await runController(config, mode);
  console.log(`\n━━━ Loop ${result.outcome.toUpperCase()} ━━━`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  console.log(`units: ${result.state.units.length}, iterations: ${result.state.budget.usage.iterations}, cost: $${result.state.budget.usage.costUsd.toFixed(4)}`);
  if (result.state.escalationIds.length) {
    console.log(`escalations: ${result.state.escalationIds.join(", ")} → ${join(config.loopDir, "escalations")}`);
  }
  console.log(`STATE.md: ${join(config.loopDir, "STATE.md")}`);
  return result.outcome === "done" ? 0 : result.outcome === "escalated" ? 2 : 1;
}

/**
 * loop task —— Phase 1+ 真实任务流水线(explore→implement→verify→integrate)。
 * 用法:loop task "<指令>" --scope src/ --gate "<cmd>" --neg "<cmd>" [--level L2|L3] [--allow src/]
 * env LOOP_TARGET 指定目标 repo。
 */
async function cmdTask(): Promise<number> {
  const args = process.argv.slice(3);
  const instruction = args.find((a) => !a.startsWith("--")) ?? "";
  if (!instruction) {
    console.log('usage: loop task "<指令>" --scope src/ --gate "<cmd>" --neg "<cmd>" [--level L2|L3] [--allow src/]');
    return 1;
  }
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const scope = (opt("scope") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const gateCmd = opt("gate");
  const negCmd = opt("neg") ?? "false"; // 默认 negative control = 必失败
  const level = (opt("level") ?? "L2") as "L1" | "L2" | "L3";
  const allow = (opt("allow") ?? scope.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

  const base = defaultConfig;
  const gates: GateSpec[] = gateCmd
    ? [{ id: "task-gate", criterion: "task gate", command: gateCmd, negativeControl: { command: negCmd } }]
    : [];
  const config: LoopConfig = {
    ...base,
    mode: "daily-triage",
    isolate: true,
    baseBranch: opt("base") ?? undefined,
    gates,
    autonomy: {
      level,
      allowCodeWrite: true,
      integrateAction: level === "L3" ? "auto" : "propose",
      allowlistPaths: allow,
    },
  };
  const mode = createTaskMode({
    id: opt("id") ?? `task-${Date.now()}`,
    title: instruction.slice(0, 60),
    instruction,
    scope,
  });
  const result = await runController(config, mode);
  console.log(`\n━━━ Task ${result.outcome.toUpperCase()} ━━━`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  console.log(`iterations: ${result.state.budget.usage.iterations}, tokens: ${result.state.budget.usage.inputTokens}/${result.state.budget.usage.outputTokens}`);
  if (result.state.escalationIds.length) console.log(`escalations: ${result.state.escalationIds.join(", ")}`);
  return result.outcome === "done" ? 0 : result.outcome === "escalated" ? 2 : 1;
}

function cmdStatus(): number {
  const config = loadConfig();
  const stateMd = join(config.loopDir, "STATE.md");
  if (existsSync(stateMd)) {
    console.log(readFileSync(stateMd, "utf8"));
  } else {
    console.log("(no STATE.md yet — run `loop run` first)");
  }
  const store = createStateStore(config.loopDir);
  const loaded = store.load();
  if (loaded.kind === "loaded") {
    const u = loaded.state.budget.usage;
    console.log(`\n── budget ──\niterations: ${u.iterations}, tokens(in/out): ${u.inputTokens}/${u.outputTokens}, cost: $${u.costUsd.toFixed(4)}`);
    console.log(`state: ${loaded.state.state}, units done: ${loaded.state.units.filter((x) => x.status === "done").length}/${loaded.state.units.length}`);
  } else if (loaded.kind === "corrupt") {
    console.log(`\n⚠️ state.json corrupt — backed up to ${loaded.backupPath}`);
  }
  return 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  let code = 0;
  switch (cmd) {
    case "run":
    case "resume":
      code = await cmdRun();
      break;
    case "task":
      code = await cmdTask();
      break;
    case "status":
      code = cmdStatus();
      break;
    default:
      console.log("usage: loop <run|resume|task|status>");
      code = 1;
  }
  process.exit(code);
}

main();
