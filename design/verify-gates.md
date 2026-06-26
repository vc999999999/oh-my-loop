# Verify:可审计证据 + 反假收敛

> goal 要求:每个 gate = **命令 + 期望阈值 + 原始输出 + verdict**,并引入 **negative control** 避免假收敛。
> 来源:harness-audit `rubric-template.md:3` + `verifier-protocol.md:56` + cortex `validateCycleOutput`。
> Gate schema 见 [schema/state.ts](schema/state.ts) `Gate` / `GateVerdict`。

## 为什么不能信 agent 自评

External Verification 不变量:「完成」由 worker **伪造不了**的东西判定。
一个只会输出 PASS 的 check = **坏温度计**,loop 会对着它开心地假收敛。
所以每个 gate 必须满足 harness-audit 的 4 原则:

1. **可命令检查** — 带 `Check:` 命令 + 数值/布尔阈值,绝不主观判断。
2. **增量验证** — 先 cheap/结构(`test -f`),后 expensive(跑测试)。loop 按序攻击。
3. **显式停止条件** — rubric 整体声明「all PASS OR N 轮 → escalate」。
4. **反假收敛** — 每个「测了验证存在」的 criterion 带 quality sub-check = negative control。

---

## Gate 的五件套(对照 schema `Gate`)

```ts
{
  id: "R3-preflight",
  criterion: "preflight 是 loop 的门(诚实退出码)",
  command: "pnpm preflight >/dev/null 2>&1; echo $?",   // ① 命令
  expect: "0",                                          // ② 期望阈值
  negativeControl: {                                    // ④ 反假收敛
    command: "引入一个故意类型错误后 pnpm preflight; echo $?",
    expectFail: true,                                   // 必须 exit ≠ 0
  },
  evidence: {                                           // ③ 原始输出(运行后填)
    rawOutput: "...完整 stdout/stderr,不是摘要...",
    measured: "actual: 0",
    exitCode: 0,
    negativeControlFailed: true,                        // negative control 如期 FAIL
  },
  verdict: "pass",                                      // ⑤ verdict
}
```

❌ 坏 gate(不能说 NO):`"AGENTS.md should be concise"`
✅ 好 gate:`wc -l < AGENTS.md` → `≤ 200`

---

## Negative control —— 验证「验证本身能 FAIL」

这是 goal 最强调的反假收敛机制。**verdict=pass 生效前**,必须证明 check 能区分:对一个**必然失败的输入**跑同一 check,它必须 FAIL。

| check 形状 | negative control(必须 exit ≠ 0) |
|---|---|
| `test -f AGENTS.md` | `test -f AGENTS.md.__nonexistent__` |
| `[ $(wc -l < f) -le 200 ]` | 喂 `seq 999 \| wc -l` |
| `grep -q reviewer agents/*.md` | `grep -q reviewer /dev/null` |
| 带退出码的脚本 | 跑一个故意违反 criterion 的 fixture |

判定升级:

| verdict | 含义 | 动作 |
|---|---|---|
| `pass` | check 在 repo 上过 **且** negative control 如期 FAIL | 计入 verified |
| `fail` | check 在 repo 上没过 | 回 execute 重试(attempts<max) |
| `uncheckable` | 命令跑不起来 | 重写 check 使其可执行;**也是 rubric 失败** |
| `invalid` | check 过了,但 negative control **也过了**(不区分) | ★ 比 uncheckable 更严重:运行但撒谎。重写 check 直到 negative control FAIL |

> 规则:`negativeControlFailed === false` → verdict 强制 `invalid`,**不计入 pass**,gate 不算通过。

---

## Maker/Checker 隔离(verifier-protocol:5)

verifier subagent **只收到**:
1. repo 路径(只读)
2. rubric(只有 gate 的 id + criterion + command + 声明的 state)
3. 采样项列表

verifier subagent **绝不收到**:
- maker 的推理("我觉得过了因为…")
- 人读的报告
- 会话历史

> 看到 maker 推理的 verifier 就退化成「带额外步骤的自我批评」。用 OpenCode 的 `task` 工具起 `Explore`(只读)子 agent 跑。

采样:验 3–5 项(不全验),**必含**任何「标 PASS 但没贴命令输出」的项——这正是确认偏误藏身处。

---

## verifier 输出可能 malformed —— Zod 兜底(抄 cortex)

verifier 自己也可能产出坏 JSON。所以:每个 gate/cycle 输出**先 Zod 校验再信任**(cortex `validateCycleOutput`)。

```ts
// 校验失败 → 用保守默认,偏向「假定失败」而非「假定成功」
const CONSERVATIVE_DEFAULTS = {
  "test.json":  { passed: false, targetsRun: [], failures: [] },
  "verify.json":{ verdict: "invalid" },   // 坏 verifier 输出 = 不可信 = 当失败
};
```

malformed verifier 输出 → `escalate(reason=verifier_invalid)`(见 [故障注入验收](phase0-l1-triage.md#故障注入验收))。

---

## rubric 文件头(整体停止条件)

```markdown
# loop-rubric — <unit>
Generated: <date>
Stop: all gates PASS OR 10 iterations → escalate(带剩余 FAIL 列表)
Re-check: 每次改动后只重跑受影响 gate;每 3 轮跑全量 rubric
```

「金规则」:闭合 rubric 前对每条问——「一个无上下文的 agent 跑这个 Check 能得到我同样的 verdict 吗?」答否 → 重写或删。
