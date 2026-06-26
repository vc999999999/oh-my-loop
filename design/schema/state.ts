/**
 * .loop/state.json — Zod schema (single source of truth)
 *
 * 设计原则(来自 goal):先定义数据形状,不写大控制器。
 * 这个文件定义 7 个核心实体的字段和状态枚举:
 *   Goal · Unit · Cycle · Budget · Gate · Escalation · AutonomyPolicy
 *
 * 来源映射(见 ../../STUDY-RESULTS.md):
 *   - Cycle / status 枚举 / parallel / taskGroup  ← cortex-harness cycle-schemas.mjs:134
 *   - unit → cycles queue                          ← cortex-harness ARCHITECTURE.md:15
 *   - Budget predicate 字段                         ← ralph-loop-agent ralph-stop-condition.ts:285
 *   - Gate.negativeControl                          ← harness-audit verifier-protocol.md:56
 *   - AutonomyLevel L1/L2/L3                        ← loop-engineering 放权阶梯
 *
 * JSON Schema 生成:这是 source of truth,需要 .loop/state.schema.json 时用
 *   `npx zod-to-json-schema` 从本文件 emit,不手维护两份。
 */

import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════
// 枚举(状态机的「合法值」集合 —— 所有分支判断都对照这里)
// ════════════════════════════════════════════════════════════════════════

/** 自治等级。L1 只报告 → L2 提方案待批 → L3 白名单内无人值守。来源:loop-engineering。 */
export const AutonomyLevel = z.enum(["L1", "L2", "L3"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/** 状态机节点。一个 unit 内部串行走过这些状态。 */
export const LoopState = z.enum([
  "trigger",    // 被定时/事件/目标唤醒
  "triage",     // 选下一个 unit,必要时拆 cycles、补 unit
  "plan",       // 为当前 cycle 出计划
  "execute",    // maker subagent 干活(隔离 worktree 内)
  "verify",     // checker + gates 判定,产可审计证据
  "integrate",  // 通过 → commit/PR(按自治等级)
  "done",       // 目标达成
  "escalate",   // 卡住/越权/重试耗尽 → 交人
]);
export type LoopState = z.infer<typeof LoopState>;

/** cycle / unit 的生命周期状态。来源:cortex CycleEntry.status。 */
export const RunStatus = z.enum(["pending", "running", "done", "partial", "blocked"]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * cycle 完成时发出的「恰好一个」signal,外层据此推进队列。
 * 来源:cortex 主循环 CYCLE_COMPLETE / CYCLE_PARTIAL / NEEDS_HUMAN_INPUT。
 */
export const CycleSignal = z.enum([
  "cycle_complete",     // 干净完成 → 推进
  "cycle_partial",      // 部分完成(turn cap / rate limit)→ 重试或注入 fix
  "needs_human_input",  // 需要人 → escalate
  "error",              // 进程级失败(spawn 失败等)→ 硬停,不重试
]);
export type CycleSignal = z.infer<typeof CycleSignal>;

/** cycle 类型。比 cortex 更泛化(不绑死前后端),保留可扩展。 */
export const CycleType = z.enum([
  "explore",
  "plan",
  "reproduce",   // fix 类 unit 先复现
  "implement",
  "reconcile",   // 跨 cycle 对齐共享契约
  "test",
  "review",      // 独立 checker
  "recovery",    // 重试耗尽后的兜底
  "deliver",
  "scope_cleanup", // scope 越界回滚失败时注入
]);
export type CycleType = z.infer<typeof CycleType>;

/** verify gate 的判定结果。来源:harness-audit verifier-protocol verdicts。 */
export const GateVerdict = z.enum([
  "pass",
  "fail",
  "uncheckable", // 命令跑不起来 —— 也是 rubric 失败
  "invalid",     // 命令跑了但不区分(negative control 没 FAIL)—— 比 uncheckable 更严重
]);
export type GateVerdict = z.infer<typeof GateVerdict>;

/** escalate 的原因分类。 */
export const EscalationReason = z.enum([
  "budget",              // 预算守卫熔断
  "retries_exhausted",   // 重试上限
  "out_of_allowlist",    // 超出当前自治等级允许范围
  "stuck_no_progress",   // 无进展/同错误重复
  "risky",               // 高风险操作需人批
  "needs_input",         // cycle 主动要人输入
  "verifier_invalid",    // 验证器自身不可信(malformed/INVALID)
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

// ════════════════════════════════════════════════════════════════════════
// Budget —— 预算守卫的配置 + 累计。来源:ralph 可组合 predicate + cortex 安全机制。
// ════════════════════════════════════════════════════════════════════════

/**
 * 预算上限配置。每个字段对应一个可组合的 stop predicate(任一命中即停 = OR)。
 * 字段为 undefined = 该 predicate 不启用。详见 ../stop-conditions.md。
 */
export const BudgetLimits = z.object({
  maxIterations: z.number().int().positive().optional(),     // iterationCountIs
  maxTokens: z.number().int().positive().optional(),         // tokenCountIs
  maxCostUsd: z.number().positive().optional(),              // costIs
  maxWallClockMs: z.number().int().positive().optional(),    // wallClockExceeds
  maxTurnsPerCycle: z.number().int().positive().default(500),// cortex SAFETY_TURN_CAP
  deadManMs: z.number().int().positive().default(20 * 60_000), // 无输出超时 → hung
  sameErrorRepeatLimit: z.number().int().positive().default(3), // sameErrorRepeats
  noProgressIterations: z.number().int().positive().default(3), // noProgressFor
  noToolCallIterations: z.number().int().positive().default(2), // noToolCallFor
  reserveUsd: z.number().nonnegative().default(0.1),         // cortex:留余量停
});
export type BudgetLimits = z.infer<typeof BudgetLimits>;

/** 预算实时累计(由 otel/tokenscope 信号喂入)。 */
export const BudgetUsage = z.object({
  iterations: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),  // ralph:cache 分价
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  startedAt: z.string().datetime(),       // 墙钟起点
  lastOutputAt: z.string().datetime().optional(), // dead-man timer 用
});
export type BudgetUsage = z.infer<typeof BudgetUsage>;

export const Budget = z.object({
  limits: BudgetLimits,
  usage: BudgetUsage,
});
export type Budget = z.infer<typeof Budget>;

// ════════════════════════════════════════════════════════════════════════
// Gate —— 一个可审计的验证门。来源:harness-audit rubric + verifier-protocol。
// 核心:命令 + 期望阈值 + 原始输出 + verdict + negative control。
// ════════════════════════════════════════════════════════════════════════

export const Gate = z.object({
  id: z.string(),                          // 如 "R3-preflight"
  criterion: z.string(),                   // 一句话:这个门测什么
  pillar: z.number().int().min(1).max(4).optional(), // harness-audit 四支柱
  /** 可执行检查:任何无上下文 agent 都能跑出同样 verdict。 */
  command: z.string(),
  expect: z.string(),                      // 期望阈值,如 "exit 0" / "≤ 200"
  /**
   * negative control —— 一个「必然失败」的输入,证明这个 check 能说 NO。
   * 没有它,check 可能是只会 PASS 的坏温度计(假收敛)。
   */
  negativeControl: z.object({
    command: z.string(),
    expectFail: z.literal(true),           // 必须 exit ≠ 0,否则 gate = invalid
  }),
  /** 运行后填充的证据(写入 journal,人可审计)。 */
  evidence: z.object({
    rawOutput: z.string(),                 // 原始 stdout/stderr,不是摘要
    measured: z.string(),                  // 实测值,如 "actual: 245"
    exitCode: z.number().int(),
    ranAt: z.string().datetime(),
    negativeControlFailed: z.boolean(),    // negative control 是否如期 FAIL
  }).optional(),
  verdict: GateVerdict.optional(),
  fixCost: z.enum(["low", "medium", "high"]).optional(),
});
export type Gate = z.infer<typeof Gate>;

// ════════════════════════════════════════════════════════════════════════
// Cycle —— unit 内部的一个工作步。来源:cortex CycleEntry。
// ════════════════════════════════════════════════════════════════════════

export const Cycle = z.object({
  id: z.string(),
  type: CycleType,
  status: RunStatus.default("pending"),
  owner: z.string().nullable().optional(),  // 负责的 agent(maker)。review/test 可空
  parallel: z.boolean().default(false),     // 能否与相邻 cycle 并行(同 unit 内极少用)
  /** 声明的 file-path scope —— 越界写触发回滚。空数组 = 不约束。来源:cortex scope。 */
  scope: z.array(z.string()).default([]),
  outputFile: z.string().optional(),        // 本 cycle 的结构化产出(Zod 校验)
  consumesOutputOf: z.array(z.string()).default([]), // 引用哪些前序 cycle 的 output
  attempts: z.number().int().nonnegative().default(0), // 重试计数。来源:Ralph Wiggum
  maxAttempts: z.number().int().positive().default(2), // cortex MAX_RETRIES=2
  gates: z.array(Gate).default([]),         // 本 cycle 的验证门
  signal: CycleSignal.optional(),           // 完成时发出的 signal
  lastError: z.string().optional(),         // 喂回下一轮重试的错误上下文(--add-context)
  blockedReason: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type Cycle = z.infer<typeof Cycle>;

// ════════════════════════════════════════════════════════════════════════
// Unit —— 一个独立工作单元(= 一个 worktree)。内部是 cycles 队列。
// 来源:cortex task-queue(unit ≈ taskGroup,cycles 是它的 queue)。
// ════════════════════════════════════════════════════════════════════════

export const Unit = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.enum(["implement", "fix", "edit", "create"]),
  status: RunStatus.default("pending"),
  worktree: z.string().optional(),          // 隔离的 worktree 路径
  dependsOn: z.array(z.string()).default([]), // 单元依赖图。来源:drydock
  cycles: z.array(Cycle).default([]),       // ★ unit → cycles queue
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  /** 进度指纹:用于 noProgress 检测(连续相同 = 无进展)。 */
  progressFingerprint: z.string().optional(),
});
export type Unit = z.infer<typeof Unit>;

// ════════════════════════════════════════════════════════════════════════
// Escalation —— 结构化交人载荷。来源:loop-engineering escalate-with-context
// + cortex human-answers.json。落盘为 .loop/escalations/<id>.json。
// ════════════════════════════════════════════════════════════════════════

export const Escalation = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  reason: EscalationReason,
  unitId: z.string().nullable(),
  cycleId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  failingCommands: z.array(z.object({       // 哪些 gate 命令失败了 + 原始输出
    command: z.string(),
    exitCode: z.number().int(),
    output: z.string(),
  })).default([]),
  diffSummary: z.string().optional(),       // 当前 worktree 的 diff 摘要
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  recommendedOptions: z.array(z.object({    // 给人的结构化选项 + 推荐
    label: z.string(),
    detail: z.string(),
    recommended: z.boolean().default(false),
  })).default([]),
  humanQuestion: z.string(),                // 一句话:需要人回答什么
  resolution: z.object({                    // 人回答后写回
    answeredAt: z.string().datetime(),
    chosen: z.string(),
    note: z.string().optional(),
  }).optional(),
});
export type Escalation = z.infer<typeof Escalation>;

// ════════════════════════════════════════════════════════════════════════
// AutonomyPolicy —— 自治门配置。来源:loop-engineering L1/L2/L3。
// ════════════════════════════════════════════════════════════════════════

export const AutonomyPolicy = z.object({
  level: AutonomyLevel.default("L1"),
  /** L3 白名单:只有匹配这些 glob 的改动可无人值守 integrate。 */
  allowlistPaths: z.array(z.string()).default([]),
  /** 哪些 cycle 类型允许无人值守(如 L1 只允许只读的 explore/test)。 */
  allowedCycleTypes: z.array(CycleType).default([]),
  /** integrate 动作:L1=none(不改代码) L2=propose(出 PR 待批) L3=auto。 */
  integrateAction: z.enum(["none", "propose", "auto"]).default("none"),
  /** 是否允许写代码(L1 daily-triage = false)。 */
  allowCodeWrite: z.boolean().default(false),
});
export type AutonomyPolicy = z.infer<typeof AutonomyPolicy>;

// ════════════════════════════════════════════════════════════════════════
// Goal —— 顶层目标 + 整个 .loop/state.json 根对象。
// ════════════════════════════════════════════════════════════════════════

export const Goal = z.object({
  id: z.string(),
  statement: z.string(),                    // 人话目标
  mode: z.string(),                         // 运行模式,如 "daily-triage"
  createdAt: z.string().datetime(),
  doneWhen: z.array(z.string()).default([]),// 目标达成判据(可被 gate 校验)
});
export type Goal = z.infer<typeof Goal>;

/** schema 版本,用于损坏/迁移检测。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * .loop/state.json 根对象 —— 机器可恢复的唯一真相。
 * kill -9 后:load(state.json) 就能重建「做到哪了」。
 */
export const LoopState_File = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  goal: Goal,
  state: LoopState.default("trigger"),      // 当前状态机位置
  autonomy: AutonomyPolicy,
  budget: Budget,
  units: z.array(Unit).default([]),
  activeUnitId: z.string().nullable().default(null),
  escalationIds: z.array(z.string()).default([]), // 指向 .loop/escalations/*.json
  updatedAt: z.string().datetime(),
});
export type LoopState_File = z.infer<typeof LoopState_File>;

/**
 * 解析 + 校验 state.json。损坏时返回 errors(不抛),由控制器决定恢复策略。
 * 来源:cortex validateCycleOutput —— 校验后才信任任何字段。
 */
export function parseLoopState(raw: unknown):
  | { ok: true; data: LoopState_File }
  | { ok: false; errors: string[] } {
  const result = LoopState_File.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
