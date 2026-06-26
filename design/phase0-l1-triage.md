# Phase 0:单一 L1 模式 + 故障注入验收

> goal 要求:Phase 0 只做**一个 L1 模式**(如 daily triage:只扫描、写 STATE.md、写 journal、**绝不改代码**)。
> **先证明可恢复性,再进 Phase 1** worktree + Verify。
> 来源:loop-engineering(L1 只报告)+ cortex(resume 读 queue)+ goal 的故障注入清单。

## 为什么 Phase 0 只做 L1

蓝图反模式:别一次到位。Phase 0 的唯一目的是**证明控制器骨架的可恢复性**——状态机能转、`.loop/` 能外化、kill -9 能续。
**不引入任何会改代码的风险**(不 execute maker、不 integrate),把「控制系统本身对不对」和「agent 干活好不好」解耦验证。

---

## daily-triage 模式规格

| 项 | 内容 |
|---|---|
| **Trigger** | opencode-scheduler 每日定时(已装插件) |
| **autonomy** | `level: L1`、`allowCodeWrite: false`、`integrateAction: none`、`allowedCycleTypes: [explore]` |
| **goal.doneWhen** | `["扫描完所有目标目录", "STATE.md 已更新", "journal 有本次记录"]` |
| **做什么** | 扫描 repo(git status / 测试状态 / TODO / 依赖告警)→ 归纳成 triage 报告 |
| **写什么** | `.loop/STATE.md`(人看的窗口)+ `.loop/journal/<date>.log`(append-only)+ `.loop/state.json`(机器真相) |
| **绝不做** | ❌ 不改任何代码 ❌ 不建 worktree ❌ 不 commit ❌ 不提方案 |
| **stop conditions** | `iterationCountIs(20)`、`costIs(2.00)`、`wallClockExceeds(15min)`、`deadManTimeout()`、`noToolCallFor(2)`(见 [stop-conditions](stop-conditions.md)) |

状态机退化:Phase 0 只走 `trigger → triage → (explore cycle, 只读) → done`,**没有 execute/verify/integrate**。escalate 仍在线(预算/卡住)。

---

## 控制器骨架(Phase 0 最小版)

```python
state = load_state(".loop/state.json")        # 损坏→走恢复策略;不存在→init
while True:
    persist(state)                             # ★ 每轮先原子写盘(可恢复地基)
    if shouldStop(stop_predicates, ctx):       # 预算守卫,横切
        escalate(state, reason="budget"); break
    unit = pick_next_unit(state)
    if unit is None and goal_done(state):      # doneWhen 判据
        mark_done(state); break
    # L1:只读 explore,产出报告,绝不改代码
    report = run_explore_readonly(unit)        # allowCodeWrite=false 强制
    write_state_md(state, report)              # 人看的窗口
    journal(state, report)                     # append-only 审计
    mark_unit_done(state, unit)
```

注意:`persist` 在**循环顶部**(每轮转移前),保证任意中断点 state.json 都完整。

---

## 故障注入验收(Phase 0 的真正考题)

> goal 明确要求:加故障注入测试作为 Phase 0 验收。**这 8 项全过 = Phase 0 完成**,做不到 = 没做完。

每项 = 注入故障 → 期望控制器的恢复行为。建议做成 `design/../tests/fault-injection/` 的可重复脚本。

| # | 注入 | 期望行为 | 依据 |
|---|---|---|---|
| 1 | **kill -9 恢复** | 跑到一半 `kill -9`,重启 `load_state` 从 `state` + `activeUnitId` 续,不重做已完成 cycle | cortex resume 读 queue;**核心验收** |
| 2 | **损坏 state** | `state.json` 写入非法 JSON / schema 不符 → `parseLoopState` 返回 errors,控制器备份到 `state.json.corrupt-<ts>`、不静默续跑、escalate | schema `parseLoopState` |
| 3 | **预算耗尽** | 把 `maxCostUsd` 设极小 → 首轮 `shouldStop` 命中 → `escalate(budget)`,不进 execute | stop-conditions A 类 |
| 4 | **验证命令超时** | gate 的 `command` 挂死 → `deadManTimeout` / per-cycle timeout 杀掉,标 `hung`,gate `uncheckable` → escalate | cortex dead-man |
| 5 | **同错误重复** | 让 explore 连续 3 轮报同一错误 → `sameErrorRepeats` 命中 → circuit breaker open → escalate | stop-conditions B 类 |
| 6 | **out-of-scope 写文件** | (Phase 0 虽不写代码,但测试这条机制)模拟一个越界写 → 4 步级联 + `restoreFromSnapshot` 回到 pre-run 内容,**不毁未提交工作** | scope-snapshot |
| 7 | **merge conflict** | (为 Phase 1 预埋)模拟 integrate 冲突 → unit `blocked` + `escalate(risky)` 带 diff 摘要,不强推 main | state-machine integrate |
| 8 | **verifier 输出 malformed** | verifier 产坏 JSON → Zod 校验失败 → `CONSERVATIVE_DEFAULTS` 偏向 fail → `escalate(verifier_invalid)`,**不当成功** | verify-gates Zod 兜底 |

**验收基线(必须先过)**:第 1 项(kill -9 续跑)和第 2 项(损坏 state 不静默)是地基,这两条不过,其它免谈。

---

## Phase 0 → Phase 1 的边界

Phase 0 全绿后才进 Phase 1,引入:
- worktree 隔离 + 一个真实 `execute → verify`(用你的测试套件当 gate)。
- autonomy 升到 L2(提 diff,人批准)。
- 接预算守卫到 otel/tokenscope 真实信号(Phase 0 可先用假信号跑通逻辑)。

> 一句话:Phase 0 不证明「agent 会干活」,只证明「**控制器摔不坏、摔了能起来**」。
