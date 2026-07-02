# prompt-conduct —— 行为准则蒸馏(Fable 5 / Claude Code → GLM-5.2)

## 目标

用 prompt 层的行为契约降低 loop 内 agent 的坏行为发生率(中途提问、谎报完成、
越界改动、结论淹没在过程输出里),作为控制器硬控制(scope 回滚 / gates / budget)
之上的第一道软约束。**软硬两层互补不互替:prompt 降发生率,控制器兜底。**

## 来源与蒸馏映射

底本:Claude Code 2.1.172 (Fable 5) 系统提示的 agentic 契约部分
(asgeirtj/system_prompts_leaks, `Anthropic/Claude Code/claude-code-2.1.172-fable-5.md`,
行为部分约前 75 行;其余 ~90KB 是工具定义,不适用)。

| CONDUCT 条款 | Fable 5 原文出处(意译) |
|---|---|
| 1. 无人值守,禁提问,遇错自行重试,完成或阻塞才结束 | "You are operating autonomously… asking will block the work" + "End your turn only when the task is complete or you are blocked" |
| 2. 信息足够就动手,不罗列不执行的方案 | "When you have enough information to act, act… give a recommendation, not an exhaustive survey" |
| 3. 最后一条消息即全部交付物,结论先行 | "Everything the user needs must be in the final text message" + "Lead with the outcome" |
| 4. 如实汇报:失败说失败,跳过说跳过,验证过才说完成 | "Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that" |
| 5. 状态变更前核实证据;禁 commit/push | "Before running a command that changes system state — check that the evidence actually supports that specific action" + 本控制器的 commit 时序约束(scope 回滚后由控制器 commit) |
| implement 的风格纪律 | "Write code that reads like the surrounding code" + "Only write a code comment to state a constraint the code itself can't show" |

聊天版 Fable 5 prompt(版权引用 / 语气 / 搜索时机等)与 loop 场景无关,全部不取。

## 为什么适配 GLM-5.2

- 智谱官方文档(docs.bigmodel.cn, GLM-5.2)明确按「生产级工程规范遵循」训练,
  推荐用法就是给显式禁止清单 + 验证要求,与本蒸馏形状一致。
- 1M 上下文下几十行准则开销可忽略;CONDUCT 作为所有 prompt 的**稳定公共前缀**,
  可命中 provider 上下文缓存。
- 精简中文重写而非照搬英文原文:system prompt 与模型训练配套,逐字迁移无意义,
  迁移的是行为契约本身。

## 机制耦合(不是修辞)

- 「最后一条消息即交付物」:`opencode-runner` 只保留最后一条 text 事件为
  `finalText`;reviewer 只解析输出中最后一个 JSON。契约与解析逻辑一一对应。
- 「越界白做」:implement prompt 里明说越界会被回滚,给模型遵守 scope 的理由,
  与 `scope.ts` 的回滚机制呼应。
- 「禁 commit/push」:控制器必须在 scope 回滚**之后**自己 commit(见 task-mode 注释),
  agent 擅自 commit 会把越界文件固化进历史。
- verifier 保持原有 JSON 契约不变(`verify.parseAndValidate` 兼容),只加了
  「有验证手段就实际运行」和「禁止未验证的 pass」两条 Fable 5 式诚实条款。

## 落点

- [src/prompts.ts](../src/prompts.ts) —— CONDUCT + explorePrompt / implementPrompt / verifierPrompt
- 接入:task-mode、queue-mode、reviewer。
- daily-triage 刻意未动:Phase 0 只读巡检有本地兜底路径,prompt 极简且稳定,
  不值得为统一而统一。

## 验证方式与结果(2026-07-02)

- **契约单测** [tests/prompts.test.ts](../tests/prompts.test.ts):CONDUCT 前缀一致性
  (缓存前提)、scope/lastError 注入、verifier JSON 契约与 `parseAndValidate` 兼容、
  多行中文 prompt 经 runner → spawn argv 原样传递。全套 50/50 pass,typecheck clean。
- **live 冒烟** `bun run smoke`([scripts/live-smoke.ts](../scripts/live-smoke.ts)):
  真实模型跑通 explore ✅ —— 最终消息严格按 prompt 要求的四段结构输出。
- **live 单独复现 implement** ✅:模型在 worktree 内完成任务后,按三段契约输出:
  file:line 级改动说明、自行跑 node 验证 add() 三组用例、诚实汇报「无 tsconfig
  无法静态校验类型」的未覆盖风险 —— CONDUCT 的自验与诚实汇报条款 live 生效。
- **live 全链路 ✅ `bun run e2e`**([scripts/e2e-live.ts](../scripts/e2e-live.ts),
  预算按慢网络放宽):真实模型跑完 explore(27s)→ implement(前 2 次撞瞬态
  provider 错误被重试机制吸收,第 3 次成功 commit)→ verify gates pass →
  L3 auto-merge → done。main 上产物验证:add(2,3)=5、hello 未动 ✅。
  瞬态重试修复在这次运行中是决定性的:没有它,implement 第一次 TLS 抖动就会硬停。
  注意:cli.ts 默认 15min 总墙钟在 provider 慢时不够(explore 一轮可达 10min),
  真实使用建议按网络情况调 `budget.maxWallClockMs`。
- **效果 A/B(待网络稳定)**:同一批任务分别用旧短 prompt 与新 conduct prompt 跑,
  对比 scope 回滚率、verify 首过率、needs_human_input 次数、平均轮数。

## live 测试暴露并修复的两个控制器缺陷

这轮 live 验证的最大产出不是 prompt 本身,而是暴露了两个只有真跑才能发现的
健壮性缺陷(均已修复 + 回归测试):

1. **瞬态 provider 错误一击即停**(controller.ts 的 `error` 分支):TLS 抖动 /
   限流第一次出现就硬停 escalate 要人介入。修复:保守白名单
   (`TRANSIENT_PROVIDER_ERROR`)匹配的错误走 partial 重试路径 + 退避
   (`transientBackoffMs`,默认 min(5s×attempts, 15s));硬兜底不变
   (maxAttempts / sameErrorRepeatLimit / budget)。非瞬态错误照旧硬停。
2. **瞬态失败误触 no_tool_call 熔断**:spawn 失败轮 toolCallCount=0,连续两次
   就被当成「agent 空转」熔断。修复:`signal==="error"` 的轮次不计入 toolHist
   —— agent 没得到行动机会不算空转;重复错误由 sameErrorRepeatLimit 兜底。

回归测试:[tests/transient-retry.test.ts](../tests/transient-retry.test.ts)
(瞬态重试成功 / 重试耗尽升级 / 非瞬态硬停 / 不误触 no_tool_call,4 例)。
