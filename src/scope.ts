/**
 * scope —— 越界检测 + 4 步回滚级联(Reversible)。
 *
 * 来源:cortex ARCHITECTURE.md:286。
 * cycle 退出后比对「实际改动文件」vs「声明 scope」,越界文件触发级联:
 *   1. restoreFromSnapshot(优先:回到 pre-run 已知 good,不毁未提交工作)
 *   2. git restore <file>
 *   3. git clean -f <file>
 *   4. git show HEAD:<path> > <file>  /  unlink(最后手段)
 * 无法完全回滚 → 返回 needsCleanup,控制器注入 scope_cleanup cycle。
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotManager } from "./snapshot.ts";

/** scope: [] = 不约束(返回空越界集)。 */
export function detectOutOfScope(changedFiles: string[], scope: string[]): string[] {
  if (!scope.length) return [];
  return changedFiles.filter((f) => {
    const n = f.replace(/\\/g, "/");
    return !scope.some((s) => n.startsWith(s.replace(/\\/g, "/")));
  });
}

export type RevertResult = { file: string; reverted: boolean; via: string };

export function revertCascade(
  root: string,
  files: string[],
  snap: SnapshotManager,
): RevertResult[] {
  return files.map((file) => revertOne(root, file, snap));
}

function revertOne(root: string, file: string, snap: SnapshotManager): RevertResult {
  // 1. 快照优先:回到 pre-run 已知 good 内容(关键:不毁用户未提交工作)
  if (snap.restoreFromSnapshot(file)) return { file, reverted: true, via: "snapshot" };

  const abs = join(root, file);
  // 2. git restore(已跟踪的修改)
  if (tryGit(root, `git restore -- "${file}"`) && isClean(root, file)) {
    return { file, reverted: true, via: "git-restore" };
  }
  // 3. git clean(未跟踪的新文件)
  if (tryGit(root, `git clean -f -- "${file}"`) && !existsSync(abs)) {
    return { file, reverted: true, via: "git-clean" };
  }
  // 4a. 从 HEAD 恢复内容
  try {
    const content = execSync(`git show HEAD:"${file}"`, { cwd: root, stdio: "pipe" });
    writeFileSync(abs, content);
    return { file, reverted: true, via: "git-show-head" };
  } catch {
    /* 文件在 HEAD 不存在 → 走删除 */
  }
  // 4b. 最后手段:删文件
  try {
    if (existsSync(abs)) unlinkSync(abs);
    return { file, reverted: true, via: "unlink" };
  } catch {
    return { file, reverted: false, via: "failed" };
  }
}

function tryGit(root: string, cmd: string): boolean {
  try {
    execSync(cmd, { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** 文件相对 HEAD 是否干净(无 diff)。 */
function isClean(root: string, file: string): boolean {
  try {
    const out = execSync(`git status --porcelain -- "${file}"`, { cwd: root, stdio: "pipe" })
      .toString()
      .trim();
    return out === "";
  } catch {
    return false;
  }
}
