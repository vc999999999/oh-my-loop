# Escalate:结构化交人

> goal 要求:Escalate 要结构化,固定生成 `.loop/escalations/<id>.json`,含:
> reason、unit、attempts、last_error、failing_commands、diff_summary、risk、recommended_options、human_question。
> 来源:loop-engineering(escalate-with-context)+ cortex(`human-answers.json` 结构化问答)+ Plannotator(approve/deny UI)。
> schema 见 [schema/state.ts](schema/state.ts) `Escalation`。

## 为什么结构化

「卡住时必须能带完整上下文交给人」是 Earned Autonomy 的兜底。
但 escalate 不能只是一句「我卡了」——人需要**足够上下文一眼决策**,且回答要能被机器读回继续。所以固定 schema。

---

## `.loop/escalations/<id>.json` 字段

| 字段 | 内容 | 为什么人需要它 |
|---|---|---|
| `id` | 唯一 id | 索引、回写 |
| `createdAt` | 时间戳 | 审计 |
| `reason` | `EscalationReason` 枚举 | 一眼知道为什么停(预算/重试耗尽/越权/卡住/需输入/verifier 不可信) |
| `unitId` / `cycleId` | 出事的单元/cycle | 定位 |
| `attempts` | 已重试几次 | 判断是否值得再试 |
| `lastError` | 最后一次错误(归一化) | 看症状 |
| `failingCommands[]` | `{command, exitCode, output}` | ★ 失败 gate 的**原始命令+输出**,人不必自己复现 |
| `diffSummary` | 当前 worktree 的 diff 摘要 | 看 agent 做了什么 |
| `risk` | low/medium/high | 决定多上心 |
| `recommendedOptions[]` | `{label, detail, recommended}` | ★ 结构化选项 + 推荐,人选一个而非自由发挥 |
| `humanQuestion` | 一句话:需要回答什么 | 明确决策点 |
| `resolution` | 人回答后写回 `{answeredAt, chosen, note}` | 机器读回 → 回 `triage` 继续 |

---

## 触发点(对照状态机)

| reason | 从哪个状态触发 | 条件 |
|---|---|---|
| `budget` | triage 入口 / execute 前 | 任一 A 类 stop predicate 命中 |
| `retries_exhausted` | verify | gate `fail` 且 `attempts >= maxAttempts` |
| `out_of_allowlist` | triage | `in_scope_and_safe` 不通过(超当前 L 级) |
| `stuck_no_progress` | execute/verify | B 类 predicate(同错误/无进展/无工具调用)+ circuit breaker open |
| `risky` | integrate | 合并冲突 / 触碰白名单外路径 |
| `needs_input` | execute | maker 发 `needs_human_input` signal |
| `verifier_invalid` | verify | verifier 输出 malformed,或 gate 判 `invalid`(negative control 没 FAIL) |

---

## 生成示例

```json
{
  "id": "esc-2026-06-26-001",
  "createdAt": "2026-06-26T08:30:00Z",
  "reason": "retries_exhausted",
  "unitId": "unit-fix-search",
  "cycleId": "test-fix-search",
  "attempts": 2,
  "lastError": "AssertionError: expected 3 results, got 0",
  "failingCommands": [
    {
      "command": "pnpm test src/search",
      "exitCode": 1,
      "output": "FAIL src/search/filter.test.ts\n  ● filter › returns matches\n    expected 3, received 0\n    at line 42..."
    }
  ],
  "diffSummary": "src/search/filter.ts: +12 -4 (改了 normalize 逻辑)",
  "risk": "medium",
  "recommendedOptions": [
    { "label": "我来手修 filter.ts", "detail": "normalize 可能吃掉了空格", "recommended": true },
    { "label": "放宽断言重试", "detail": "把期望从精确 3 改成 ≥1", "recommended": false },
    { "label": "标记 blocked 跳过此 unit", "detail": "先做其它单元", "recommended": false }
  ],
  "humanQuestion": "filter 重写两次仍返回 0 结果,要我怎么处理?"
}
```

---

## 人机界面(L2/L3 接线)

- **L2**:`integrateAction=propose` → escalate 出口接 **Plannotator** 的 submit_plan / approve-deny UI,人看 diff + options 点批准。
- **回写**:人答完 → `resolution` 写回 → 控制器 `load_state` 检测到 resolution → 回 `triage` 续跑(抄 cortex `resume` 读 `human-answers.json`)。
- **L1**:不出方案,escalation 只是「报告 + 停」,人手动决定下一步。

---

## 与 STATE.md 的关系

- `.loop/escalations/<id>.json` = 机器可读、结构化、可回写。
- `.loop/STATE.md` = 人看的窗口,escalate 时在顶部插一段人话摘要 + 指向对应 escalation json。
- 两者一起满足 loop-engineering 的 escalate-with-context:**机器有结构、人有上下文**。
