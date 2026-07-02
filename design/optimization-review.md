# 优化复盘 —— 我额外发现的可改进点

> goal 末尾:「你再看看哪些还能优化的地方」。
> 下面是我读完源码 + 整合设计后,**超出 goal 显式清单**的优化建议。按「该不该现在做」分级,避免过度设计。

## 🟢 现在就该纳入(低成本、补真空)

### O1. journal 用 ndjson 而非 logfmt,直接喂 otel
- **现状**:STUDY-RESULTS 里 simple-memory 用 logfmt;但 meguri 用 `timeline.ndjson`。
- **优化**:journal 每条状态转移写一行 **ndjson**(`{ts, state, unit, cycle, signal, evidence?}`)。ndjson 既是审计源,又能被 otel exporter 直接消费(蓝图说 journal 就是 otel 导出的东西)。logfmt 还要再解析一次。
- **成本**:几乎为零,定个 schema 就行。

### O2. state.json 与 journal 的「双写一致性」
- **风险**:`persist(state.json)` 和 `journal.append()` 是两次写。若在两者之间 kill -9,可能 journal 有记录但 state 没更新(或反之)。
- **优化**:**journal 先写,state.json 后写**。恢复时以 state.json 为准,journal 多出的尾条 = 「正在做但没确认完成」的 cycle,重启时该 cycle 重跑(幂等)。明确这个顺序,故障注入 #1 才真的稳。
- **依据**:cortex 的 queue 驱动 + session.json 审计分离,本质就是这个。

### O3. 进度指纹要包含「字节级 diff size」,不只是 status
- **现状**:stop-conditions 的 `noProgressFor` 用 `hash(status + activeUnit + cycle.id + diff 行数)`。
- **风险**:agent 可能在同一 cycle 内反复改同几行(行数不变但内容在抖),指纹看起来「没进展」其实在挣扎,或反过来。
- **优化**:指纹用 `git diff --stat` 的**累计字节变化**而非行数;再叠加「测试通过数」作为正向进度信号。两个都不动才算真无进展。

### O4. gate 的 `command` 必须在 worktree 内、超时受控地跑
- **现状**:verify-gates 定义了 command 但没规定执行环境。
- **优化**:明确 gate command 在该 unit 的 **worktree cwd** 跑(不是主仓),且每条 command 单独 `maxTurnsPerCycle`/timeout(对应故障注入 #4)。否则一个挂死的 gate 拖垮整轮。

---

## 🟡 Phase 1+ 再做(有价值但现在过早)

### O5. 单元依赖图的拓扑排序 + 死锁检测
- schema 已有 `Unit.dependsOn`(来自 drydock)。但 `pick_next_unit` 现在没说怎么用。
- Phase 3 并行时:按 `dependsOn` 拓扑排序选 unit,检测环(A↔B 互相依赖 = 死锁 → escalate)。现在单元串行,先不实现,但 schema 已留字段。

### O6. negative control 的「缓存」
- 每个 gate 每轮都重跑 negative control 成本不低(harness-audit 建议每轮至少 1 个 PASS 项做)。
- 优化:negative control 结果对「同一 command + 同一 repo HEAD」可缓存,HEAD 变了才重算。Phase 1 有真实测试套件后再上,避免过早优化。

### O7. escalation 去重 / 聚合
- 同一个 root cause 可能在多个 unit 触发多条 escalation,淹没人。
- 优化:`escalation` 加 `fingerprint`(reason + 归一化 lastError),相同指纹的合并成一条带 `affectedUnits[]`。Phase 2 多 unit 并行后才需要。

### O8. context 膨胀控制(D 档插件接入点)
- 长 loop 的 token 会爆。蓝图 D 档有 snip / dynamic-context-pruning / morph。
- 现在 schema 里 budget 已能熔断,但「主动裁剪」要等真实长跑出现痛点(蓝图明确说「记忆/裁剪只在真正需要时加」)。预留:journal 已外化,context 可随时从 journal 重建,不必全留在对话里。

---

## 🔴 明确不做(避免过度设计 / 违背蓝图)

| 不做 | 为什么 |
|---|---|
| 不引入分布式状态存储(像 drydock 的 API/web 服务) | 蓝图:`.loop/` 文件 + git 就够。服务化是 30 个插件式的复杂度,Phase 3 前不碰 |
| 不并行化阶段 | 铁律:并行的是独立 unit,不是阶段。把 execute/verify 并行 = 反模式 |
| 不做语义记忆/RAG | 蓝图:记忆只在真正需要检索时加。现在 journal 够 |
| 不自造 issue tracker | 已装 beads(badri/wt 证明 beads 可当单元状态机)。Phase 3 直接接,不重造 `Unit` 持久层 |
| 不一上来给 L3 | Earned Autonomy:L1 跑稳 → 单模式白名单升 L3。不为「省事」跳级 |

---

## 一句话

goal 的 10 条已覆盖控制器主干;我补的主要是**持久化一致性(O1/O2)**和**进度判定的鲁棒性(O3)**这两处「魔鬼在细节」的地方——它们正是故障注入 #1/#5 真正考验的东西。其余都标了「Phase 几再做」,守住蓝图「小而连贯的核心」的底线。

---

## 2026-07-02 二轮优化(交付后复盘 → 已全部落地)

来源:prompt-conduct 交付后的全局复盘,四项结构性优化,全部带回归测试
([tests/optimizations.test.ts](../tests/optimizations.test.ts),54/54 pass + typecheck clean)。

| # | 优化 | 落点 | 机制 |
|---|---|---|---|
| P1 | explore 计划复用(原来 implement 从零摸仓库,探查白花) | schema `Unit.explorePlan` + prompts/task-mode/queue-mode | explore 成功的 finalText 持久化在 unit 上(resume 不丢),注入 implement prompt(截断 4000 字防稀释) |
| P2 | checker 只读从软约束升级为可硬化 | `LoopConfig.agents{maker,checker}` → runSession `--agent` | 在 opencode 配置里定义受限 agent 后,`--checker <agent>` 即工具级只读;不配则保持现状 |
| P3 | resume 预算刷新(原来提额重跑撞旧 limits 立刻再熔断) | controller 载入分支 | limits 以本次 config 为准(usage 照旧累计),墙钟起点重置——跨会话等人批准的时间不计入 |
| P4 | 单 cycle 与全 loop 墙钟拆分(原来一个字段身兼两职,慢网络下互相打架) | schema `perCycleWallClockMs` + modes/reviewer + cli `--budget-min/--cycle-min` | 不设 perCycle 则沿用 maxWallClockMs(旧行为零破坏) |

仍留待后续:效果 A/B(旧短 prompt vs conduct prompt 的回滚率/首过率/轮数对比)
——需稳定网络下的批量真实任务,框架(journal + ledger + roi)已就绪。
