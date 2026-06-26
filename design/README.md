# design/ —— Loop 控制器设计包

> 这是从 STUDY-RESULTS.md 的借鉴点沉淀出的**控制器设计**。
> 原则(来自 goal):**先定 schema,不写大控制器**。本包是规格 + 类型,不是实现。
> 上游蓝图见 `~/Downloads/opencode-loop-blueprint.md`;研读计划见 STUDY-PLAN.md。

## 五条不变量(全局判据)

来自 loop-engineering,所有设计都为满足这五条服务,缺一条 = bug:

- **External Truth** — 真相在 `.loop/` 文件,不在对话 → [schema](schema/state.ts) + [scope-snapshot](scope-snapshot.md)
- **External Verification** — 完成由命令判定,negative control 防假收敛 → [verify-gates](verify-gates.md)
- **Bounded** — 三独立停止维度(达成/预算/卡住)→ [stop-conditions](stop-conditions.md)
- **Reversible** — worktree + scope + 快照回滚 → [scope-snapshot](scope-snapshot.md)
- **Earned Autonomy** — L1→L2→L3 逐步挣 → [schema](schema/state.ts) `AutonomyPolicy` + [escalation](escalation.md)

## 文件索引

| 文件 | 内容 | 主要来源 |
|---|---|---|
| [schema/state.ts](schema/state.ts) | ★ **地基**:Goal/Unit/Cycle/Budget/Gate/Escalation/AutonomyPolicy 的 Zod schema + 枚举 | cortex cycle-schemas / ralph / harness-audit |
| [state-machine.md](state-machine.md) | 状态机**转移表**(entry/exit/signals/side-effects/失败记录) | conductor / cortex 主循环 |
| [stop-conditions.md](stop-conditions.md) | 可组合停止 predicate(iter/token/cost/wallclock/same-error/no-progress/no-tool-call) | ralph-loop-agent / goal-plugin |
| [verify-gates.md](verify-gates.md) | gate 五件套 + negative control + verifier 隔离 + Zod 兜底 | harness-audit |
| [scope-snapshot.md](scope-snapshot.md) | scope 越界检测 + 4 步回滚 + pre-run snapshot 三函数 | cortex ARCHITECTURE / snapshot.mjs |
| [escalation.md](escalation.md) | 结构化 `.loop/escalations/<id>.json` | loop-engineering / cortex / Plannotator |
| [phase0-l1-triage.md](phase0-l1-triage.md) | Phase 0 单一 L1 模式 + **8 项故障注入验收** | loop-engineering / goal 清单 |
| [optimization-review.md](optimization-review.md) | 我额外发现的优化点(分级:现在做/Phase1+/不做) | 自评 |

## `.loop/` 目录(运行时产物,本包定义其 schema)

```
.loop/
  state.json          # 机器真相(schema/state.ts 的 LoopState_File);提交进 git
  STATE.md            # 人看的窗口;提交
  journal/<date>.ndjson  # append-only 审计 + otel 源;提交
  escalations/<id>.json  # 结构化交人;提交
  snapshot/           # byte-perfect 回滚 blob;★ 不提交(.gitignore)
  units/<id>/         # 每单元的 diff + verifier 报告;提交
```

## 构建顺序 —— ✅ 4 阶段全部实现(见 `../controller/`,22/22 测试 + 真实 opencode 端到端)

- ✅ **Phase 0**:控制器骨架 + `.loop/` schema + 单一 L1 daily-triage(只读)+ 8 项故障注入(kill-9 续跑等)。
- ✅ **Phase 1**:worktree 隔离 + 真实 execute→verify(gate)+ scope/snapshot 回滚 + L2 propose。
- ✅ **Phase 2**:maker/checker 分离(独立 fresh-context review)+ 安全门 fail-closed + L3 白名单 auto-merge。
- ✅ **Phase 3**:跨独立 unit 并行(拓扑批次)+ 串行 integrate + 合并冲突隔离。

> 后续可选增强(出现真实痛点再加):otel/tokenscope 真实预算信号回灌、Plannotator escalate UI、记忆检索。

## 一句话

控制器那 20%(状态机 / 停止 predicate / negative-control 验证 / scope 快照 / 结构化 escalate)没有任何插件能给——本包定规格,`../controller/` 是其完整实现。
