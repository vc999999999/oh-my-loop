# opencode-loop-controller

OpenCode 的**外层控制器**:状态机 + 预算守卫 + 自治门。不是插件——它在 session 外面,spawn 并驱动 `opencode run`,所以能做插件做不到的事(kill-9 恢复、外部熔断、worktree 管理、判定 done)。

设计依据见 [`design/`](design/)。

## 前置条件

- [Bun](https://bun.sh)(运行时)
- [OpenCode](https://opencode.ai) 已安装、**已登录授权、且有一个可用 model**(控制器靠 spawn `opencode run` 干活;`loop run`/`loop task` 都依赖它)。先确认 `opencode run "hello"` 能正常返回。
- `git`(worktree 隔离 / scope 回滚 / integrate 都用 git)
- gate 命令依赖的工具(如你用 `--gate "pnpm test"` 就需要 pnpm)

## 状态:4 阶段全部实现并验证(22/22 测试 + 真实 opencode 端到端)

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 状态机 + `.loop/` 外化 + 停止条件 + daily-triage L1 + 8 项故障注入 | ✅ |
| Phase 1 | worktree 隔离 + execute/verify gate + scope/snapshot 回滚 + L2 propose | ✅ |
| Phase 2 | maker/checker 分离(独立 review)+ 安全门 fail-closed + L3 白名单 | ✅ |
| Phase 3 | 跨独立 unit 并行 + 串行 integrate + 合并冲突隔离 | ✅ |

## 安装 / 运行

```bash
cd controller && bun install

# Phase 0:只读日常巡检(写 .loop/STATE.md,不改代码)
LOOP_TARGET=/path/to/repo bun run src/cli.ts run
LOOP_USE_AGENT=1 LOOP_TARGET=/path/to/repo bun run src/cli.ts run   # 带 AI 总结

# Phase 1-3:真实任务流水线(explore→implement→verify→integrate,真 opencode agent)
LOOP_TARGET=/path/to/repo bun run src/cli.ts task "你的任务" \
  --scope src/ --gate "pnpm test" --neg "false" --level L3 --allow src/ --base main

# L2 批准闭环:人批准提案后自动合并(reject 则驳回)
LOOP_TARGET=/path/to/repo bun run src/cli.ts approve <unitId|escalationId> [--note "..."]
LOOP_TARGET=/path/to/repo bun run src/cli.ts reject  <unitId|escalationId>

# 跨会话预算账本 + 阈值告警
LOOP_TARGET=/path/to/repo bun run src/cli.ts budget

# 查看状态
LOOP_TARGET=/path/to/repo bun run src/cli.ts status
```

命令一览:`run`(L1 巡检)· `task`(L1-L3 单任务流水线)· `approve`/`reject`(L2 批准闭环)· `budget`(跨会话账本)· `status`。

### 多任务队列 + 依赖图

代码方式用 `createQueueMode([...])`(见 [src/modes/queue-mode.ts](src/modes/queue-mode.ts)):一次播种多个带 `dependsOn` 的 unit,控制器按依赖拓扑依次跑,成环自动 escalate(deadlock)。串行编排走主控制器,并行编排见 [src/parallel.ts](src/parallel.ts)。

`loop task` 参数:`--scope`(允许写的路径,越界回滚)·`--gate`(验证命令)·`--neg`(negative control,必须失败)·`--level L1|L2|L3` · `--allow`(L3 自动合并白名单)· `--base`(合并目标分支)。

## 架构(三层)

```
外层控制器(本项目)──spawn `opencode run --format json`──▶ 插件层(已装 21 个)──读写──▶ .loop/(git 内状态)
状态机·预算守卫·自治门·worktree·scope/snapshot·gate·escalate     执行器/底座                  可恢复真相
```

## 模块

| 文件 | 职责 |
|---|---|
| `src/schema/state.ts` | Zod schema:Goal/Unit/Cycle/Budget/Gate/Escalation/AutonomyPolicy |
| `src/controller.ts` | 主循环(状态机):trigger→triage→execute→verify→integrate→done,预算守卫横切 |
| `src/state-store.ts` `journal.ts` | 状态外化:原子写 + 损坏检测;ndjson 审计(journal 先写 state 后写) |
| `src/stop-conditions.ts` `budget.ts` `progress.ts` | 可组合停止 predicate(iter/token/cost/wallclock/same-error/no-progress/no-tool-call) |
| `src/opencode-runner.ts` | spawn `opencode run --format json`,解析事件,外层 dead-man/wallclock 杀进程 |
| `src/worktree.ts` `snapshot.ts` `scope.ts` | 隔离 + pre-run 快照 + 越界 4 步回滚(回到已知 good,非裸 HEAD) |
| `src/gates.ts` `verify.ts` `reviewer.ts` | 验证门(命令+阈值+negative control)+ Zod 兜底 + 独立 fresh-context checker |
| `src/safety.ts` | 安全门 fail-closed(破坏性命令/密钥写入拦截) |
| `src/integrate.ts` | L1 none / L2 propose / L3 auto(白名单)+ 冲突检测 |
| `src/parallel.ts` | Phase 3 并行编排:拓扑批次并发 + 串行合并冲突隔离 |
| `src/ledger.ts` | 跨会话预算账本(budget-ledger.ndjson)+ 阈值告警 |
| `src/modes/` | daily-triage(L1 只读)/ task(单任务)/ queue(多任务+依赖图) |

## 测试

```bash
bun test          # 31 个:8 故障注入 + Phase1-3(13)+ 不变量 + escalation/approve(3)+ queue(3)+ ledger(3)
bunx tsc --noEmit # strict 类型检查
```

真实 opencode 端到端已验证:daily-triage(token 真实累加)+ task pipeline(agent 写代码 → gate 验证 → L3 自动合并 → 代码可运行)。

## 致谢 / 借鉴(Attribution)

本控制器是独立实现,但若干机制借鉴/移植自这些上游项目,在此致谢:

- **[cortex-harness](https://github.com/arnavranjan005/cortex-harness)**(MIT)— `snapshot.ts` 的 pre-run 快照三函数移植自其 `src/snapshot.mjs`;`opencode-runner.ts` 的事件解析参照其 opencode CLI adapter;cycle 输出 Zod 校验 + 保守默认的思路来自其 `cycle-schemas.mjs`。
- **[ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent)** — `stop-conditions.ts` 的可组合 predicate(OR 短路)+ `budget.ts` 的 cache 分价成本算法来自其 stop-condition 实现。
- **[harness-audit](https://github.com/andrami-pro/harness-audit)** — `gates.ts` / `verify.ts` 的「命令 + 阈值 + negative control」验证门 + 反假收敛思路来自其 rubric / verifier-protocol。
- **[loop-engineering](https://github.com/cobusgreyling/loop-engineering)** — 「loop 是控制系统」框架、五条不变量、L1/L2/L3 放权阶梯、escalate-with-context。

## License

[MIT](LICENSE)
