# Scope 强隔离 + 快照恢复(Reversible)

> goal 要求:scope enforcement 要更硬。借 Cortex 的 **scope + snapshot** 机制,不能只靠 worktree;
> out-of-scope 写入要恢复到 **pre-run snapshot**,而不是粗暴 `git restore`。
> 来源:cortex `ARCHITECTURE.md:286`(scope cascade)+ `snapshot.mjs:89`(snapshot 三函数)。

## 为什么 worktree 不够

worktree 只隔离了「不同 unit 互不干扰」。但**单个 cycle 的 maker agent 仍可在自己 worktree 内乱写**——改了不该改的文件、动了共享契约。所以要有第二层:**声明 scope + 退出后比对 + 越界回滚**。

每个 cycle 在 schema 里带 `scope: string[]`(file-path 前缀)。`scope: []` = 不约束(新项目默认)。

---

## 越界检测 + 4 步回滚级联(cortex:286)

每个 cycle **退出后**,比对「实际改动文件」vs「声明 scope」。越界文件触发级联:

```
1. git restore <file>             # 恢复已跟踪的修改
2. git clean -f <file>            # 删未跟踪的新文件
3. git show HEAD:<path> > <file>  # 必要时从上次 commit 恢复
4. fs.unlinkSync(<file>)          # 最后手段:删文件
```

级联仍无法完全回滚 → 注入一个 `scope_cleanup-<cycleId>` cycle 进队列,继续前先清理。

---

## ★ 关键升级:pre-run snapshot(snapshot.mjs)

**问题**:上面的 `git restore` / `git clean` 是「钝器」——它把文件打回 `HEAD`,**会连用户开跑前的未提交工作一起毁掉**。

**解法**:快照让回滚回到「最近已知 good」而非裸 HEAD。三个函数(直接对应 cortex `snapshot.mjs`):

### `createPreRunSnapshot()` — 跑任何 cycle 前一次性
- 抓所有未提交文件:`git diff --name-only HEAD` + `git ls-files --others --exclude-standard`。
- 每个存成 **byte-perfect Buffer blob**(`readFileSync` 不带 encoding)到 `.loop/snapshot/`,索引在 `snapshot.json`。
- 排除快照目录自身(blob 文件名前缀 `blob-`,视觉区分)。
- **跳过 lock 文件**(`package-lock.json` / `pnpm-lock.yaml` / `Cargo.lock` 等)——每次 install 都变,snapshot 它没意义。

### `refreshSnapshot(cycle)` — 每个成功的 in-scope cycle 后
- 读 cycle 报告的 `filesChanged[]`,过滤到该 agent scope 内的路径,**只重抓这些**。
- 含义:快照始终反映**最新的 valid in-scope 状态**,不只是开跑前状态。
- **Stale blob 剪枝**:之前脏、现在干净(回到 HEAD)的文件,blob + 索引项删掉——快照目录不无限膨胀。
- reconcile cycle 无 agent 但能改共享文件,也刷新(同模式)。

### `restoreFromSnapshot(filePath)` — 回滚级联调用,替代裸 HEAD
- 有 blob → 按 byte 写回;无 blob → 退回普通 git 回滚。

**净效果**:越界写被回滚到「该文件最近的已知 good 内容」——要么是用户开跑前的未提交工作,要么是本次 run 早先 cycle 的 valid in-scope 编辑——**而不是 HEAD 碰巧是什么**。

---

## `.loop/snapshot/` 结构

```
.loop/snapshot/
  snapshot.json          # 索引:{ "<relpath>": { blobFile, capturedAt } }
  blob-src_foo_bar.ts    # byte-perfect Buffer,文件名 = 路径 sanitize
  blob-...
```

`.gitignore` 里排除 `.loop/snapshot/`(是 harness 内部物,不提交)。注意区别:`.loop/state.json` / `journal/` **要**提交(可 review、可恢复);`snapshot/` **不**提交。

---

## 与安全门的关系(已装插件,只接线)

scope/snapshot 管「越界写**事后**回滚」;安全门管「破坏性命令**事前**拦」:

| 层 | 时机 | 来源 | 接线 |
|---|---|---|---|
| CC Safety Net | 命令执行**前** | PreToolUse hook、fail-closed | 已装,`rm -rf` 等在跑之前拦 |
| Envsitter Guard | 工具执行**前** | `tool.execute.before` | 已装,.env read-only |
| scope cascade | cycle 退出**后** | cortex(本文) | 控制器自己写 |
| pre-run snapshot | 回滚**时** | cortex(本文) | 控制器自己写 |

四层叠加 = Reversible 不变量:门没过绝不碰 main、失败干净回滚、回滚不毁用户工作。
