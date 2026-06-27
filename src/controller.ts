/**
 * controller —— 主循环(状态机)。
 *
 * 实现 design/state-machine.md。Phase 0 路径:
 *   trigger → triage → execute(只读 explore × N cycles)→ done
 * 横切:每轮顶部 persist + 预算守卫 shouldStop;命中 → escalate。
 *
 * 可测性:runCycle / now / predicates 都可注入(故障注入测试用)。
 * 可恢复:每个 cycle 完成后 journal 先写、state 后写;resume 跳过 done cycle。
 */

import {
  Unit,
  Cycle,
  Budget,
  AutonomyPolicy,
  type LoopState_File,
  type Unit as UnitT,
  type Cycle as CycleT,
} from "./schema/state.ts";
import { createStateStore, type StateStore } from "./state-store.ts";
import { createJournal, type Journal } from "./journal.ts";
import { createEscalator, type Escalator } from "./escalation.ts";
import { defaultPredicates, shouldStop, type StopPredicate, type StopContext } from "./stop-conditions.ts";
import { accumulate, totalTokens } from "./budget.ts";
import { progressFingerprint, errorFingerprint } from "./progress.ts";
import type { StepUsage } from "./opencode-runner.ts";
import type { LoopConfig } from "../loop.config.ts";
import { ensureWorktree, changedFiles as wtChangedFiles, diffSummary as wtDiffSummary, commitAll as wtCommitAll } from "./worktree.ts";
import { createSnapshotManager } from "./snapshot.ts";
import { detectOutOfScope, revertCascade } from "./scope.ts";
import { runGates } from "./gates.ts";
import { integrateUnit } from "./integrate.ts";
import { writeUnitArtifacts } from "./unit-artifacts.ts";
import { defaultReviewer } from "./reviewer.ts";
import { createLedger } from "./ledger.ts";
import { join } from "node:path";

export type CycleOutcome = {
  signal: "cycle_complete" | "cycle_partial" | "needs_human_input" | "error";
  steps: StepUsage[];
  toolCallCount: number;
  finalText: string | null;
  lastError: string | null;
  /** 本 cycle 是否真的驱动了 opencode agent。false(本地确定性步骤)时不计入 noToolCall 历史。 */
  ranAgent?: boolean;
};

/** 一个模式提供:怎么 plan 出 cycles、怎么跑一个 cycle、单元完成后做什么。 */
export type Mode = {
  /** triage:无 pending unit 时,造出本轮要做的 unit(含 cycles)。 */
  planUnit: (state: LoopState_File, config: LoopConfig) => UnitT;
  /** 队列模式(可选):首次一次性播种多个 unit(可带 dependsOn)。提供后控制器按依赖拓扑依次跑。 */
  seedUnits?: (state: LoopState_File, config: LoopConfig) => UnitT[];
  /** 跑一个 cycle(只读 explore 等)。 */
  runCycle: (args: {
    state: LoopState_File;
    unit: UnitT;
    cycle: CycleT;
    config: LoopConfig;
  }) => Promise<CycleOutcome>;
  /** 单元所有 cycle 完成后(L1:写 STATE.md,不 integrate)。 */
  onUnitDone?: (state: LoopState_File, unit: UnitT, config: LoopConfig) => void;
};

export type ControllerDeps = {
  store?: StateStore;
  journal?: Journal;
  escalator?: Escalator;
  predicates?: StopPredicate[];
  now?: () => number;
  /** 安全上限:防测试/bug 真无限循环。 */
  maxLoops?: number;
  /** 独立 checker(maker/checker 分离)。默认起全新 opencode session;测试可注入。 */
  reviewer?: (args: { workdir: string; unit: UnitT; cycle: CycleT; config: LoopConfig }) => Promise<CycleOutcome>;
};

export type ControllerResult = {
  outcome: "done" | "escalated" | "halted";
  reason?: string;
  state: LoopState_File;
};

async function runControllerInner(
  config: LoopConfig,
  mode: Mode,
  deps: ControllerDeps = {},
): Promise<ControllerResult> {
  const store = deps.store ?? createStateStore(config.loopDir);
  const journal = deps.journal ?? createJournal(config.loopDir);
  const escalator = deps.escalator ?? createEscalator(config.loopDir, journal);
  const predicates = deps.predicates ?? defaultPredicates;
  const now = deps.now ?? (() => Date.now());
  const maxLoops = deps.maxLoops ?? 1000;

  // —— trigger:load 或 init ——
  const loaded = store.load();
  let state: LoopState_File;
  if (loaded.kind === "loaded") {
    state = loaded.state;
    journal.append({ event: "triggered", state: state.state, detail: { resumed: true } });
  } else if (loaded.kind === "corrupt") {
    // 损坏:不静默续跑。init 一个新的并立即 escalate(corrupt 已备份)。
    state = initState(store, config);
    escalator.escalate(state, {
      reason: "needs_input",
      humanQuestion: `state.json 损坏,已备份到 ${loaded.backupPath}。错误:${loaded.errors.join("; ")}。是否从新 state 继续?`,
      risk: "high",
      lastError: loaded.errors.join("; "),
    });
    store.persist(state);
    return { outcome: "escalated", reason: "corrupt_state", state };
  } else {
    state = initState(store, config);
    journal.append({ event: "triggered", state: "trigger", detail: { resumed: false } });
  }

  // —— 队列模式:首次播种多个 unit(带 dependsOn)——
  if (state.units.length === 0 && mode.seedUnits) {
    const seeded = mode.seedUnits(state, config);
    state.units.push(...seeded);
    journal.append({ event: "units_seeded", detail: { count: seeded.length, ids: seeded.map((u) => u.id) } });
    store.persist(state);
  }

  // 跨轮的停止条件历史
  const errHist: string[] = [];
  const progHist: string[] = [];
  const toolHist: number[] = [];
  let iteration = state.budget.usage.iterations;

  for (let loop = 0; loop < maxLoops; loop++) {
    // —— 每轮顶部:journal 先、persist 后(O2)——
    journal.append({ event: "loop_top", state: state.state, detail: { iteration } });
    store.persist(state);

    // —— 预算守卫(横切)——
    const ctx: StopContext = {
      iteration,
      usage: state.budget.usage,
      limits: state.budget.limits,
      now: now(),
      recentErrorFingerprints: errHist,
      recentProgressFingerprints: progHist,
      recentToolCallCounts: toolHist,
    };
    const stop = shouldStop(predicates, ctx);
    if (stop.stop) {
      const isResource =
        stop.reason === "cost" || stop.reason === "token" || stop.reason === "iteration" ||
        stop.reason === "wallclock" || stop.reason === "deadman";
      // 现场快照:让预算/卡住型交人也能一眼看清「为什么停、烧了多少、最近在挣扎什么」
      const activeUnit = state.activeUnitId ? state.units.find((u) => u.id === state.activeUnitId) : undefined;
      escalator.escalate(state, {
        reason: isResource ? "budget" : "stuck_no_progress",
        unitId: activeUnit?.id ?? null,
        attempts: iteration,
        humanQuestion: `loop 被停止条件 [${stop.reason}] 熔断,是否调整预算/介入?`,
        lastError: `stop: ${stop.reason}`,
        risk: "medium",
        diffSummary: activeUnit?.worktree ? wtDiffSummary(activeUnit.worktree, config.baseBranch ?? "HEAD") : undefined,
        stopContext: {
          firedPredicate: stop.reason!,
          iteration,
          tokens: totalTokens(state.budget.usage),
          costUsd: state.budget.usage.costUsd,
          wallClockMs: now() - Date.parse(state.budget.usage.startedAt),
          recentErrors: errHist.slice(-5),
          recentProgress: progHist.slice(-5),
        },
        recommendedOptions: isResource
          ? [
              { label: "提高预算并继续", detail: `当前命中 ${stop.reason};放宽对应 limit 后重跑同一 .loop/state.json`, recommended: true },
              { label: "就此停止", detail: "接受当前进度,不再投入预算" },
            ]
          : [
              { label: "人工接管该 unit", detail: `loop 在 [${stop.reason}] 上空转,需人判断卡点`, recommended: true },
              { label: "调整任务/scope 后重跑", detail: "可能是任务本身无解或 scope 太窄" },
            ],
      });
      store.persist(state);
      return { outcome: "escalated", reason: stop.reason, state };
    }

    // —— triage:选 unit(依赖感知)——
    let unit = pickActiveUnit(state);
    if (!unit) {
      const pending = state.units.filter((u) => u.status === "pending" || u.status === "running");
      if (pending.length > 0) {
        // 有 pending 但没一个 deps 满足 → 依赖死锁 / 环
        escalator.escalate(state, {
          reason: "stuck_no_progress",
          humanQuestion: `依赖死锁:这些 unit 的 dependsOn 无法满足(可能成环或依赖了 blocked 单元):${pending.map((u) => u.id).join(", ")}`,
          lastError: "dependency deadlock",
          risk: "medium",
        });
        store.persist(state);
        return { outcome: "escalated", reason: "deadlock", state };
      }
      if (state.units.length > 0) {
        // 没有 pending(全 done,或剩下的已 blocked 并各自 escalate 过)→ 收尾
        state.state = "done";
        journal.append({ event: "done", state: "done", detail: { allDone: allUnitsDone(state) } });
        store.persist(state);
        return { outcome: "done", state };
      }
      // 无任何 unit(单 unit 模式)→ plan 一个
      state.state = "triage";
      unit = mode.planUnit(state, config);
      state.units.push(unit);
      state.activeUnitId = unit.id;
      journal.append({ event: "unit_planned", unit: unit.id, detail: { cycles: unit.cycles.length } });
      store.persist(state);
    }
    state.activeUnitId = unit.id;

    // —— 隔离 + 快照(Phase 1):unit 第一次激活时建 worktree + pre-run snapshot ——
    const workdir = ensureUnitWorkspace(unit, config, journal);

    // —— 选 unit 的下一个 pending cycle ——
    const cycle = unit.cycles.find((c) => c.status === "pending" || c.status === "running");
    if (!cycle) {
      // 单元完成 → 先把可审计产物落盘(diff 必须在 merge 前抓),再 integrate(按自治等级)
      writeUnitArtifacts(config.loopDir, unit, { baseBranch: config.baseBranch ?? "HEAD" });
      const integ = integrateUnit(state, unit, { root: config.target, baseBranch: config.baseBranch });
      journal.append({ event: "integrate", unit: unit.id, detail: { kind: integ.kind } });
      if (integ.kind === "conflict") {
        unit.status = "blocked";
        escalator.escalate(state, {
          reason: "risky",
          unitId: unit.id,
          humanQuestion: `unit ${unit.id} 合并冲突,需人解决`,
          risk: "high",
          diffSummary: unit.worktree ? wtDiffSummary(unit.worktree, config.baseBranch ?? "HEAD") : undefined,
          failingCommands: [{ command: "git merge", exitCode: 1, output: integ.output.slice(-2000) }],
        });
        store.persist(state);
        return { outcome: "escalated", reason: "merge_conflict", state };
      }
      if (integ.kind === "proposed" || integ.kind === "out_of_allowlist") {
        // L2 提案 / L3 越白名单 → 待人批准
        unit.status = "done"; // 工作完成,等批准 integrate
        mode.onUnitDone?.(state, unit, config);
        state.activeUnitId = null;
        escalator.escalate(state, {
          reason: integ.kind === "out_of_allowlist" ? "out_of_allowlist" : "needs_input",
          unitId: unit.id,
          humanQuestion: `unit ${unit.id} 已完成,提案待批准:${integ.proposalPath}`,
          risk: integ.kind === "out_of_allowlist" ? "high" : "medium",
          recommendedOptions: [
            { label: "批准并合并", detail: integ.proposalPath, recommended: true },
            { label: "驳回", detail: "丢弃 worktree 分支" },
          ],
        });
        store.persist(state);
        return { outcome: "escalated", reason: "awaiting_approval", state };
      }
      // recorded(L1)/ merged(L3 成功)
      unit.status = "done";
      // 回写终态 + integrate 结果(diff.patch 已在 merge 前抓好,空 patch 不覆盖)
      writeUnitArtifacts(config.loopDir, unit, { baseBranch: config.baseBranch ?? "HEAD", integrate: integ.kind });
      mode.onUnitDone?.(state, unit, config);
      state.activeUnitId = null;
      journal.append({ event: "unit_done", unit: unit.id, detail: { integrate: integ.kind } });
      store.persist(state);
      continue;
    }

    // —— execute / verify:跑 cycle ——
    const isVerify = cycle.type === "verify";
    state.state = isVerify ? "verify" : "execute";
    cycle.status = "running";
    cycle.startedAt = new Date().toISOString();
    journal.append({ event: "cycle_start", unit: unit.id, cycle: cycle.id, state: state.state });
    store.persist(state);

    let outcome: CycleOutcome;
    if (isVerify && config.gates?.length) {
      // verify cycle:跑门(命令 + negative control),不调 agent
      const gr = runGates(config.gates, workdir);
      cycle.gates = gr.gates;
      const failDesc = gr.failing.map((g) => `${g.id}:${g.verdict}`).join(", ");
      if (gr.verdict === "pass") {
        outcome = { signal: "cycle_complete", steps: [], toolCallCount: 0, finalText: "all gates pass", lastError: null };
      } else if (gr.verdict === "invalid" || gr.verdict === "uncheckable") {
        // verifier 不可信 → 直接 escalate(不当成功也不当普通失败)
        cycle.status = "blocked";
        cycle.lastError = `gates ${gr.verdict}: ${failDesc}`;
        writeUnitArtifacts(config.loopDir, unit, { baseBranch: config.baseBranch ?? "HEAD", integrate: "blocked" });
        escalator.escalate(state, {
          reason: "verifier_invalid",
          unitId: unit.id,
          cycleId: cycle.id,
          lastError: cycle.lastError,
          humanQuestion: `验证门不可信(${gr.verdict}):${failDesc}`,
          failingCommands: gr.failing.map((g) => ({
            command: g.command,
            exitCode: g.evidence?.exitCode ?? -1,
            output: g.evidence?.rawOutput ?? "",
          })),
        });
        store.persist(state);
        return { outcome: "escalated", reason: "verifier_invalid", state };
      } else {
        // gate fail → 回边:重置前一个 implement cycle,带错误上下文重做
        outcome = { signal: "cycle_partial", steps: [], toolCallCount: 0, finalText: null, lastError: `gates failed: ${failDesc}` };
        const prior = priorImplementCycle(unit, cycle);
        if (prior) {
          prior.status = "pending";
          prior.lastError = `verify 失败,需修复:${failDesc}`;
          prior.attempts++;
        }
      }
    } else if (cycle.type === "review") {
      // maker/checker 分离:独立 checker(fresh context,不见 maker 推理)
      const review = deps.reviewer ?? defaultReviewerAdapter;
      outcome = await review({ state, unit, cycle, config, workdir } as any);
      if (outcome.signal === "cycle_partial") {
        // checker 不通过 → 回边重做前序 implement
        const prior = priorImplementCycle(unit, cycle);
        if (prior) {
          prior.status = "pending";
          prior.lastError = `review 不通过:${outcome.lastError ?? ""}`;
          prior.attempts++;
        }
      }
    } else {
      outcome = await mode.runCycle({ state, unit, cycle, config });
      // scope 强隔离:agent cycle 退出后比对越界写 → 回滚(必须在 commit 之前)
      if (config.isolate && unit.worktree) {
        if (cycle.scope.length) {
          const changed = wtChangedFiles(unit.worktree, config.baseBranch ?? "HEAD");
          const oos = detectOutOfScope(changed, cycle.scope);
          if (oos.length) {
            const snap = createSnapshotManager({ snapshotDir: snapshotDirFor(workdir), root: unit.worktree });
            const reverted = revertCascade(unit.worktree, oos, snap);
            journal.append({ event: "scope_revert", unit: unit.id, cycle: cycle.id, detail: { reverted } });
          }
        }
        // 回滚后再固化 in-scope 改动(便于 verify / integrate)
        if (wtCommitAll(unit.worktree, `loop: ${cycle.id}`)) {
          journal.append({ event: "cycle_commit", unit: unit.id, cycle: cycle.id });
        }
      }
    }

    // 累加预算
    for (const step of outcome.steps) {
      state.budget.usage = accumulate(state.budget.usage, step);
    }
    iteration++;
    state.budget.usage.iterations = iteration;

    // 更新停止条件历史
    errHist.push(errorFingerprint(outcome.lastError));
    progHist.push(progressFingerprint(state, config.target));
    // noToolCall 只对真正驱动了 agent 的 cycle 有意义;本地确定性步骤不计入。
    if (outcome.ranAgent) toolHist.push(outcome.toolCallCount);

    cycle.signal = outcome.signal;
    cycle.turns = (cycle.turns ?? 0) + 1;

    if (outcome.signal === "cycle_complete") {
      cycle.status = "done";
      cycle.completedAt = new Date().toISOString();
      journal.append({ event: "cycle_complete", unit: unit.id, cycle: cycle.id, signal: "cycle_complete" });
    } else if (outcome.signal === "needs_human_input") {
      cycle.status = "blocked";
      cycle.lastError = outcome.lastError ?? undefined;
      escalator.escalate(state, {
        reason: "needs_input",
        unitId: unit.id,
        cycleId: cycle.id,
        attempts: cycle.attempts,
        lastError: outcome.lastError ?? undefined,
        humanQuestion: outcome.finalText ?? "cycle 需要人输入",
      });
      store.persist(state);
      return { outcome: "escalated", reason: "needs_input", state };
    } else if (outcome.signal === "error") {
      // 进程级失败:硬停该 cycle,不重试
      cycle.status = "blocked";
      cycle.lastError = outcome.lastError ?? undefined;
      escalator.escalate(state, {
        reason: "risky",
        unitId: unit.id,
        cycleId: cycle.id,
        attempts: cycle.attempts,
        lastError: outcome.lastError ?? undefined,
        humanQuestion: `cycle ${cycle.id} 进程级失败,需人介入`,
        risk: "high",
      });
      store.persist(state);
      return { outcome: "escalated", reason: "error", state };
    } else {
      // partial:重试或耗尽
      cycle.attempts++;
      cycle.lastError = outcome.lastError ?? undefined;
      unit.lastError = outcome.lastError ?? undefined;
      if (cycle.attempts >= cycle.maxAttempts) {
        cycle.status = "blocked";
        writeUnitArtifacts(config.loopDir, unit, { baseBranch: config.baseBranch ?? "HEAD", integrate: "blocked" });
        escalator.escalate(state, {
          reason: "retries_exhausted",
          unitId: unit.id,
          cycleId: cycle.id,
          attempts: cycle.attempts,
          lastError: outcome.lastError ?? undefined,
          humanQuestion: `cycle ${cycle.id} 重试 ${cycle.attempts} 次仍失败`,
        });
        store.persist(state);
        return { outcome: "escalated", reason: "retries_exhausted", state };
      }
      cycle.status = "pending"; // 回 execute 重试
      journal.append({
        event: "cycle_retry",
        unit: unit.id,
        cycle: cycle.id,
        signal: "cycle_partial",
        detail: { attempts: cycle.attempts },
      });
    }

    store.persist(state);
  }

  return { outcome: "halted", reason: "max_loops", state };
}

/**
 * runController —— 对外入口。跑控制器,然后把本次 run 的用量记进跨会话账本(F1),
 * 并按 config.ledgerThreshold 做累计阈值告警。
 */
export async function runController(
  config: LoopConfig,
  mode: Mode,
  deps: ControllerDeps = {},
): Promise<ControllerResult> {
  const result = await runControllerInner(config, mode, deps);
  try {
    const ledger = createLedger(config.loopDir);
    ledger.record(result.state.goal.id, result.outcome, result.state.budget.usage);
    if (config.ledgerThreshold) {
      const alerts = ledger.checkThresholds(config.ledgerThreshold);
      if (alerts.length) {
        (deps.journal ?? createJournal(config.loopDir)).append({ event: "budget_alert", detail: { alerts } });
      }
    }
  } catch {
    /* 账本 best-effort,不影响主流程 */
  }
  return result;
}

function initState(store: StateStore, config: LoopConfig): LoopState_File {
  return store.init({
    goalStatement: `${config.mode} on ${config.target}`,
    mode: config.mode,
    autonomy: AutonomyPolicy.parse({
      level: config.autonomy.level,
      allowCodeWrite: config.autonomy.allowCodeWrite,
      integrateAction: config.autonomy.integrateAction,
      allowlistPaths: config.autonomy.allowlistPaths ?? [],
      allowedCycleTypes: ["explore", "implement", "verify"],
    }),
    budget: Budget.parse({
      limits: { ...config.budget },
      usage: { startedAt: new Date().toISOString() },
    }),
  });
}

/** 一个 unit 的 dependsOn 是否全部 done。 */
function depsMet(state: LoopState_File, u: UnitT): boolean {
  return (u.dependsOn ?? []).every((d) => state.units.find((x) => x.id === d)?.status === "done");
}

function pickActiveUnit(state: LoopState_File): UnitT | undefined {
  if (state.activeUnitId) {
    const u = state.units.find((x) => x.id === state.activeUnitId);
    if (u && u.status !== "done" && u.status !== "blocked" && depsMet(state, u)) return u;
  }
  // 选第一个「pending/running 且依赖已满足」的 unit
  return state.units.find((u) => (u.status === "pending" || u.status === "running") && depsMet(state, u));
}

function allUnitsDone(state: LoopState_File): boolean {
  return state.units.length > 0 && state.units.every((u) => u.status === "done");
}

function snapshotDirFor(workdir: string): string {
  return join(workdir, ".loop", "snapshot");
}

/**
 * unit 第一次激活时:建 worktree(若 isolate)+ pre-run snapshot。幂等。
 * 返回该 unit 干活的目录(worktree 或 target)。
 */
function ensureUnitWorkspace(unit: UnitT, config: LoopConfig, journal: Journal): string {
  let workdir = config.target;
  if (config.isolate) {
    if (!unit.worktree) {
      const wt = ensureWorktree(config.target, unit.id, config.baseBranch);
      unit.worktree = wt.path;
      journal.append({ event: "worktree_created", unit: unit.id, detail: { path: wt.path, branch: wt.branch } });
    }
    workdir = unit.worktree;
  }
  // 只在首次激活(无任何 cycle 跑过)时抓 pre-run snapshot
  const fresh = unit.cycles.every((c) => c.status === "pending");
  if (fresh) {
    try {
      const snap = createSnapshotManager({ snapshotDir: snapshotDirFor(workdir), root: workdir });
      snap.createPreRunSnapshot();
    } catch {
      /* 非 git 或无未提交文件:跳过 */
    }
  }
  return workdir;
}

/** 找 verify/review cycle 之前最近的一个 implement/explore cycle —— 回边目标。 */
function priorImplementCycle(unit: UnitT, gateCycle: CycleT): CycleT | undefined {
  const idx = unit.cycles.findIndex((c) => c.id === gateCycle.id);
  for (let i = idx - 1; i >= 0; i--) {
    const t = unit.cycles[i]!.type;
    if (t !== "verify" && t !== "review") return unit.cycles[i];
  }
  return undefined;
}

/** 默认 review 适配:把控制器上下文映射成 defaultReviewer 的入参(只给 repo+criterion+改动文件)。 */
async function defaultReviewerAdapter(args: {
  unit: UnitT;
  cycle: CycleT;
  config: LoopConfig;
  workdir: string;
}): Promise<CycleOutcome> {
  const changed = args.unit.worktree
    ? wtChangedFiles(args.unit.worktree, args.config.baseBranch ?? "HEAD")
    : [];
  return defaultReviewer({
    workdir: args.workdir,
    criterion: args.cycle.lastError ? `${args.unit.title}(上轮:${args.cycle.lastError})` : args.unit.title,
    changedFiles: changed,
    model: args.config.model ?? null,
    deadManMs: args.config.budget.deadManMs ?? 300_000,
    wallClockMs: args.config.budget.maxWallClockMs ?? 900_000,
  });
}

export { Unit, Cycle };
