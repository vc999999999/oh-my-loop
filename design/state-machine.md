# 状态机:转移表(非图)

> goal 要求:状态机要有**转移表**,不只要图。每个状态写清 entry/exit/allowed signals/side effects/失败如何记录。
> 来源:conductor(entry/exit 条件)、cortex `ARCHITECTURE.md:214`(signal 驱动队列)、Superpowers(maker/checker 分离)。
> 枚举值见 [schema/state.ts](schema/state.ts) `LoopState` / `CycleSignal`。

## ⚠️ 两条铁律(先看)

1. **一个 unit 内部是串行流水线**:`triage → plan → execute → verify → integrate`。**不要并行化阶段**。
2. **并行是跨独立 unit 的**:N 个 unit、N 个 worktree,各自跑完整串行流水线,**只在 integrate 处串行合并**。
3. **Maker 永远无权宣布成功**:`execute` 的 agent 和 `verify` 的 agent 是不同角色、不同 prompt、不同 context。

---

## 转移表

每个状态恰好消费上一步的 signal,执行 side effects,产出下一步的 signal。所有 side effects 都**先写盘 `.loop/` 再转移**(可恢复)。

### `trigger`
| 项 | 内容 |
|---|---|
| **entry 条件** | 定时器触发 / goal 事件 / 手动启动;`.loop/state.json` 存在则 load,不存在则 init |
| **exit 条件** | state.json 已加载且 schema 校验通过 → `triage` |
| **allowed signals** | (无,入口) |
| **side effects** | `load_state()` 或 `init_state()`;写 `journal/` 一条 `triggered` |
| **失败记录** | state.json 损坏 → 不转移,走恢复策略(见 [fault-injection](phase0-l1-triage.md#故障注入验收));损坏备份到 `state.json.corrupt-<ts>` |

### `triage`
| 项 | 内容 |
|---|---|
| **entry 条件** | 来自 `trigger` 或某 unit 完成后回流 |
| **exit 条件** | `pick_next_unit()` 返回 unit → `plan`;返回 null(无 pending 且目标判据满足)→ `done` |
| **allowed signals** | `cycle_complete`(上个 unit 完成)/ 无(首次) |
| **side effects** | 可拆 unit→cycles;可按 `requiresAdditionalGroups` **动态补 unit**(来源 cortex:183);更新 `units[]`、`activeUnitId` |
| **失败记录** | 拆分失败 → 该 unit `status=blocked`,`lastError` 记原因;不阻塞其它 unit |
| **预算守卫** | ★ 进入前先跑 [stop-conditions](stop-conditions.md):任一命中 → `escalate(reason=budget)` |
| **自治门** | ★ `in_scope_and_safe(unit, autonomy)` 不通过 → `escalate(reason=out_of_allowlist)` |

### `plan`
| 项 | 内容 |
|---|---|
| **entry 条件** | 选定 unit 的下一个 `pending` cycle |
| **exit 条件** | cycle 有可执行计划 + 声明了 `scope` → `execute` |
| **allowed signals** | (内部) |
| **side effects** | 写 cycle 的 plan;确认 `worktree` 已建(`ensure_worktree`);写 `createPreRunSnapshot()`(见 [scope-snapshot](scope-snapshot.md)) |
| **失败记录** | 无法规划 → cycle `partial`,attempts+1,回 `triage` 或 escalate |

### `execute`(maker)
| 项 | 内容 |
|---|---|
| **entry 条件** | cycle 有 plan + worktree 就绪 |
| **exit 条件** | maker subagent 退出,产出 `outputFile`(Zod 校验)→ `verify` |
| **allowed signals** | maker 发 `cycle_complete` / `cycle_partial` / `needs_human_input` / `error` |
| **side effects** | 在 worktree 内跑(隔离);**每 cycle 退出后比对改动 vs scope**,越界 → 回滚级联(见 scope-snapshot);记 `turns`、token、cost 累加进 `budget.usage` |
| **失败记录** | `error` signal(进程失败)→ 硬停该 cycle,`blocked`,**不重试**;`partial`(turn cap/rate limit)→ attempts+1 |
| **关键** | maker **不判定自己成功**,只产出 outputFile 交给 verify |

### `verify`(checker,fresh context)
| 项 | 内容 |
|---|---|
| **entry 条件** | execute 产出了 outputFile |
| **exit 条件** | 所有 gate `pass`(且 negative control 都 FAIL 过)→ `integrate`;有 `fail` 且 attempts<max → 回 `execute`(retry);`fail` 且 attempts 耗尽 → `escalate`;`invalid`/`uncheckable` → `escalate(reason=verifier_invalid)` |
| **allowed signals** | gate verdicts:`pass`/`fail`/`uncheckable`/`invalid` |
| **side effects** | 跑每个 gate 的 `command` + `negativeControl`;把**命令+期望+原始输出+verdict**写进 `journal/`(可审计);verifier subagent **只拿 repo 路径+rubric+采样项,绝不拿 maker 推理**(来源 harness-audit:5) |
| **失败记录** | verifier 输出 malformed → Zod 校验失败 → 用 `CONSERVATIVE_DEFAULTS`(偏向 `passed:false`),记 `verifier_invalid` |
| **反假收敛** | 任一 gate 的 negative control **没 FAIL** → 该 gate `invalid`,不计入 pass(见 [verify-gates](verify-gates.md)) |

### `integrate`
| 项 | 内容 |
|---|---|
| **entry 条件** | 当前 unit 所有 cycle 的 gate 全 pass |
| **exit 条件** | 按 `autonomy.integrateAction`:`none`(L1,只记录不合并)/ `propose`(L2,出 PR 待批 → escalate 给人)/ `auto`(L3,白名单内直接 commit/merge)→ 回 `triage` 取下个 unit |
| **allowed signals** | (内部) |
| **side effects** | 合并到主干前先**串行**(跨 unit 合并点);冲突 → 注入 `reconcile`/escalate;`record_success` |
| **失败记录** | 合并冲突 → unit `blocked`,`escalate(reason=risky)` 带 diff 摘要 |

### `done`
| 项 | 内容 |
|---|---|
| **entry 条件** | `pick_next_unit` 返回 null + `goal.doneWhen` 判据(可被 gate 校验)全满足 |
| **exit 条件** | 终态。写 `STATE.md` 最终总结 + `journal/` 一条 `done` |
| **side effects** | 打印 run summary(done/partial/blocked/pending/duration/cost,来源 cortex:235) |

### `escalate`
| 项 | 内容 |
|---|---|
| **entry 条件** | 预算熔断 / 重试耗尽 / 越权 / 卡住 / 需输入 / verifier 不可信 |
| **exit 条件** | 生成 `.loop/escalations/<id>.json`(结构化,见 [escalation](escalation.md));L1/L2 停下等人;人回答写回 `resolution` 后回 `triage` |
| **allowed signals** | `needs_human_input` |
| **side effects** | 冻结当前 unit;`escalationIds[]` 追加;`journal/` 记 `escalated` + reason |
| **失败记录** | 这是失败的**汇集点**——所有不可自动恢复的失败最终落到结构化 escalation |

---

## 状态转移总览(图只是辅助,表才是规格)

```
trigger → triage ─(unit)→ plan → execute → verify ─pass→ integrate ─next→ triage
             │                       ▲          │                          │
             │                       └──retry≤N──┤(fail & attempts<max)     │
             │                                   │                          │
             ├─(null & goal met)──────────────→ done ←──────────────────────┘
             │
             └─(budget/out-of-allowlist)─┐
   execute/verify ─(stuck/exhausted/invalid/risky)─┴─→ escalate ─(human answers)→ triage
```

预算守卫与自治门是**横切的**:在 `triage` 入口、每轮 `execute` 前都检查,可从任何状态打断到 `escalate`。

---

## 每轮持久化(可恢复性的实现)

每个状态转移**之前**:`persist(state)` 原子写 `.loop/state.json`(写临时文件 + rename,来源 simple-memory)。
保证:任意时刻 kill -9,`.loop/state.json` 都是一个**完整且 schema-valid** 的快照,重启 `load_state()` 从 `state` 字段 + `activeUnitId` 续跑。
