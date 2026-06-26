/**
 * worktree —— 每个 unit 一个隔离的 git worktree(Reversible)。
 *
 * 来源:蓝图隔离不变量 + cortex/badri-wt 的 worktree 用法。
 * ensureWorktree:为 unit 建一个分支 + worktree;removeWorktree:清理。
 * 干活在一次性 worktree 里;门没过绝不碰 main。
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function git(root: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: root, stdio: "pipe" }).toString().trim();
}

function gitSafe(root: string, cmd: string): boolean {
  try {
    git(root, cmd);
    return true;
  } catch {
    return false;
  }
}

export type Worktree = { path: string; branch: string };

/** 工具/harness 产物:opencode 运行时目录 + 控制器自身目录。永不纳入 scope/commit/allowlist。 */
const TOOL_ARTIFACTS = [".opencode/", ".logs/", ".loop/", ".opencode", ".logs", ".loop"];

function isArtifact(file: string): boolean {
  const n = file.replace(/\\/g, "/");
  return TOOL_ARTIFACTS.some((a) => n === a || n.startsWith(a.endsWith("/") ? a : a + "/"));
}

/**
 * 为 unit 建/取 worktree。幂等:已存在则直接返回(可恢复——kill-9 后 resume 复用)。
 * worktree 放在 <root>/.loop/worktrees/<unitId>,分支 loop/<unitId>。
 */
export function ensureWorktree(root: string, unitId: string, baseBranch?: string): Worktree {
  const branch = `loop/${unitId}`;
  const path = join(root, ".loop", "worktrees", unitId);

  if (existsSync(join(path, ".git"))) return { path, branch };

  const base = baseBranch ?? currentBranch(root);
  // 分支已存在则复用,否则从 base 建
  const hasBranch = gitSafe(root, `rev-parse --verify --quiet ${branch}`);
  if (hasBranch) {
    git(root, `worktree add "${path}" ${branch}`);
  } else {
    git(root, `worktree add -b ${branch} "${path}" ${base}`);
  }
  return { path, branch };
}

export function removeWorktree(root: string, unitId: string, opts: { deleteBranch?: boolean } = {}): void {
  const branch = `loop/${unitId}`;
  const path = join(root, ".loop", "worktrees", unitId);
  if (existsSync(path)) gitSafe(root, `worktree remove --force "${path}"`);
  if (opts.deleteBranch) gitSafe(root, `branch -D ${branch}`);
}

/** 把 worktree 分支合并回 base。返回 {merged, conflict, output}。 */
export function mergeWorktree(
  root: string,
  unitId: string,
  baseBranch?: string,
): { merged: boolean; conflict: boolean; output: string } {
  const branch = `loop/${unitId}`;
  const base = baseBranch ?? currentBranch(root);
  try {
    git(root, `checkout ${base}`);
    const out = git(root, `merge --no-ff -m "loop: merge ${unitId}" ${branch}`);
    return { merged: true, conflict: false, output: out };
  } catch (e) {
    const output = (e as any).stdout?.toString?.() ?? (e as Error).message;
    const conflict = /conflict/i.test(output);
    if (conflict) gitSafe(root, "merge --abort"); // 不留半合并状态
    return { merged: false, conflict, output };
  }
}

/** worktree 内相对 base 改了哪些文件。 */
export function changedFiles(worktreePath: string, baseBranch: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${baseBranch}`, { cwd: worktreePath, stdio: "pipe" })
      .toString()
      .trim();
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: worktreePath, stdio: "pipe" })
      .toString()
      .trim();
    return [...splitLines(out), ...splitLines(untracked)].filter((f) => !isArtifact(f));
  } catch {
    return [];
  }
}

/** worktree 内把改动 commit(execute 后,verify 前固化)。 */
export function commitAll(worktreePath: string, message: string): boolean {
  try {
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
    // 把工具产物从 index 移除(opencode 的 .opencode/.logs、控制器的 .loop)
    for (const a of [".opencode", ".logs", ".loop"]) {
      try {
        execSync(`git reset -q -- ${a}`, { cwd: worktreePath, stdio: "pipe" });
      } catch {
        /* 该路径不存在,忽略 */
      }
    }
    // index 里有没有真东西要提交
    const staged = execSync("git diff --cached --name-only", { cwd: worktreePath, stdio: "pipe" }).toString().trim();
    if (!staged) return false;
    execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { cwd: worktreePath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function diffSummary(worktreePath: string, baseBranch: string): string {
  try {
    return execSync(`git diff --shortstat ${baseBranch}`, { cwd: worktreePath, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}

function currentBranch(root: string): string {
  try {
    return git(root, "rev-parse --abbrev-ref HEAD");
  } catch {
    return "main";
  }
}

function splitLines(s: string): string[] {
  return s ? s.split("\n").map((x) => x.trim()).filter(Boolean) : [];
}
