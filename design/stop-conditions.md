# 停止条件:一等公民

> goal 要求:不要只写 `budget_exceeded(state)`,要像 ralph-loop-agent 一样有**可组合 predicate**。
> 来源:ralph-loop-agent `ralph-stop-condition.ts:285` + goal-plugin(noProgress/noToolCall)+ Ralph Wiggum(同错误)+ cortex(dead-man/turn cap)。
> 配置字段见 [schema/state.ts](schema/state.ts) `BudgetLimits` / `BudgetUsage`。

## 核心模式(抄 ralph)

ralph 的做法:停止条件是一组 **predicate `(ctx) => boolean`**,`isRalphStopConditionMet` 跑全部、取 `.some()`——**任一命中即停(OR)**。

```ts
export type StopContext = {
  iteration: number;
  usage: BudgetUsage;       // tokens/cost/时间
  limits: BudgetLimits;
  recentErrors: string[];   // 最近 N 轮的错误指纹
  progressFingerprints: string[]; // 最近 N 轮的进度指纹
  toolCallsThisIter: number;
  model: string;
};
export type StopPredicate = (ctx: StopContext) => boolean;

/** 任一命中即停 —— 抄 ralph isRalphStopConditionMet 的 .some() */
export function shouldStop(preds: StopPredicate[], ctx: StopContext):
  { stop: boolean; reason?: string } {
  for (const p of preds) {
    if (p(ctx)) return { stop: true, reason: p.name };
  }
  return { stop: false };
}
```

预算守卫 = 「always-on 的 `shouldStop`」,在 `triage` 入口和每轮 `execute` 前跑。命中 → `escalate`。

---

## Predicate 清单

### A. 资源类(直接抄 ralph,补墙钟)

| predicate | 命中条件 | 来源 |
|---|---|---|
| `iterationCountIs` | `iteration >= limits.maxIterations` | ralph:285 |
| `tokenCountIs` | `usage.in+out >= limits.maxTokens` | ralph:297 |
| `costIs` | `calcCost(usage) >= limits.maxCostUsd` | ralph:345 |
| `wallClockExceeds` | `now - usage.startedAt >= limits.maxWallClockMs` | cortex dead-man 的墙钟版 |
| `turnCapExceeds` | 单 cycle `turns >= limits.maxTurnsPerCycle`(默认 500) | cortex SAFETY_TURN_CAP |
| `deadManTimeout` | `now - usage.lastOutputAt >= limits.deadManMs`(默认 20min)→ 标 `hung` | cortex DEAD_MAN_MS |

**成本计算必须算 cache 分价**(抄 ralph `calculateCost:250`):
```ts
inputCost = uncached*inRate + cacheRead*cacheReadRate + cacheWrite*cacheWriteRate
```
否则对 prompt caching 重的 loop 高估几倍 → 误熔断。数据源:tokenscope 的 per-model cost + otel 的 step-finish telemetry。

### B. 进展类(新增 —— goal-plugin + Ralph Wiggum)

这三个是「资源没耗尽但其实在空转」的信号,**独立于预算**,是 goal 明确点名要补的:

| predicate | 命中条件 | 来源 | 为什么需要 |
|---|---|---|---|
| `sameErrorRepeats` | `recentErrors` 末尾 `>= sameErrorRepeatLimit`(默认 3)条指纹相同 | Ralph Wiggum struggle indicator | 同一个错误连撞 3 次 = 重试无意义,再撞只烧钱 |
| `noProgressFor` | `progressFingerprints` 末尾 `>= noProgressIterations`(默认 3)条相同 | goal-plugin noProgress | 状态指纹不变 = 没推进,可能死循环 |
| `noToolCallFor` | 连续 `>= noToolCallIterations`(默认 2)轮 `toolCallsThisIter == 0` | goal-plugin noToolCall | agent 只说话不动手 = 卡住或在兜圈 |

**指纹怎么算**:
- 错误指纹 = `hash(归一化后的 lastError)`(去掉时间戳/路径噪音)。
- 进度指纹 = `hash(units 各 status + activeUnitId + 当前 cycle.id + diff 行数)`。连续相同说明世界没变。

### C. circuit breaker 三态(抄 lodeloop)

不是单个 predicate,是包在重试外层的状态:
- **closed**:正常跑。
- **open**:`sameErrorRepeats` 或连续失败超阈 → 直接 `escalate`,不再试。
- **half-open**:人介入/冷却后,放**一次**试探;成功 → closed,失败 → 立刻回 open。

---

## 三个独立停止维度(Bounded 不变量)

goal 的 Bounded 要求三个**相互独立**的停止条件,映射到上面:

| 维度 | 由谁保证 | 命中后 |
|---|---|---|
| (a) 目标达成 | `pick_next_unit→null` + `goal.doneWhen` gate | `done` |
| (b) 预算耗尽 | A 类 predicate(iter/token/cost/wallclock) | `escalate(budget)` |
| (c) 卡住升级 | B 类 predicate + circuit breaker open | `escalate(stuck_no_progress)` |

> ❌ 只能靠 (a) 停的 loop 是危险的。三个维度必须同时在线。

---

## 配置示例(daily-triage,L1)

```ts
const stopPredicates = [
  iterationCountIs(20),          // L1 扫描不该超 20 轮
  costIs(2.00),                  // 单次 triage 封顶 $2
  wallClockExceeds(15 * 60_000), // 15 分钟
  deadManTimeout(),              // 20min 无输出
  noToolCallFor(2),              // 只读模式下 2 轮不调工具 = 卡了
  sameErrorRepeats(3),
];
```
