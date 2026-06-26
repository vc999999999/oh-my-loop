/**
 * snapshot —— pre-run 快照管理(非破坏性回滚)。
 *
 * 移植自 cortex-harness src/snapshot.mjs:
 *   - createPreRunSnapshot:跑任何 cycle 前,抓所有未提交文件为 byte-perfect Buffer blob。
 *   - refreshSnapshot:每个成功 in-scope cycle 后,只重抓 scope 内改动文件。
 *   - restoreFromSnapshot:回滚级联调用,写回 blob 而非裸 HEAD(不毁用户未提交工作)。
 * 跳过 lock 文件;stale blob 剪枝;blob 文件名前缀 blob-。
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";

const SKIP_LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
]);

type SnapshotIndex = Record<string, { blobFile: string; capturedAt: string }>;

export function createSnapshotManager(opts: { snapshotDir: string; root: string }) {
  const { snapshotDir, root } = opts;
  const indexPath = join(snapshotDir, "snapshot.json");

  function readIndex(): SnapshotIndex {
    if (!existsSync(indexPath)) return {};
    try {
      return JSON.parse(readFileSync(indexPath, "utf8")) as SnapshotIndex;
    } catch {
      return {};
    }
  }

  function writeIndex(index: SnapshotIndex): void {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  function blobPath(filePath: string): string {
    const sanitized = filePath.replace(/[/\\:*?"<>|]/g, "_");
    return join(snapshotDir, `blob-${sanitized}`);
  }

  function captureFiles(filePaths: string[]): void {
    if (!filePaths.length) return;
    mkdirSync(snapshotDir, { recursive: true });
    const index = readIndex();
    for (const f of filePaths) {
      const basename = f.split(/[/\\]/).at(-1)!;
      if (SKIP_LOCK_FILES.has(basename)) continue;
      const abs = join(root, f);
      if (!existsSync(abs)) continue;
      try {
        const content = readFileSync(abs); // Buffer — byte-perfect
        const blob = blobPath(f);
        writeFileSync(blob, content);
        index[f] = { blobFile: relative(snapshotDir, blob), capturedAt: new Date().toISOString() };
      } catch {
        /* best-effort */
      }
    }
    writeIndex(index);
  }

  function gitLines(cmd: string): string[] {
    try {
      const out = execSync(cmd, { cwd: root, stdio: "pipe" }).toString().trim();
      return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function createPreRunSnapshot(): number {
    let dirty = [
      ...gitLines("git diff --name-only HEAD"),
      ...gitLines("git ls-files --others --exclude-standard"),
    ];
    // 排除快照目录自身
    const snapRel = relative(root, snapshotDir).replace(/\\/g, "/");
    dirty = dirty.filter((f) => !f.replace(/\\/g, "/").startsWith(snapRel + "/"));

    // 剪枝:不再脏的文件,删 blob + 索引项
    const dirtySet = new Set(dirty.map((f) => f.replace(/\\/g, "/")));
    const index = readIndex();
    for (const key of Object.keys(index)) {
      if (!dirtySet.has(key.replace(/\\/g, "/"))) {
        const blob = join(snapshotDir, index[key]!.blobFile);
        try {
          if (existsSync(blob)) unlinkSync(blob);
        } catch {
          /* best-effort */
        }
        delete index[key];
      }
    }
    writeIndex(index);

    captureFiles(dirty);
    return dirty.length;
  }

  /** 刷新:重抓给定 scope 内的改动文件(成功 cycle 后调用)。 */
  function refreshSnapshot(filesChanged: string[], scope: string[]): void {
    if (!scope.length) return;
    const inScope = filesChanged.filter((f) => {
      const n = f.replace(/\\/g, "/");
      return scope.some((s) => n.startsWith(s.replace(/\\/g, "/")));
    });
    captureFiles(inScope);
  }

  /** 回滚:有 blob → byte-perfect 写回;无 → false(交给 git 回滚)。 */
  function restoreFromSnapshot(filePath: string): boolean {
    const n = filePath.replace(/\\/g, "/");
    const index = readIndex();
    const entry = index[n] ?? index[filePath];
    if (!entry) return false;
    const blob = join(snapshotDir, entry.blobFile);
    if (!existsSync(blob)) return false;
    try {
      writeFileSync(join(root, n), readFileSync(blob));
      return true;
    } catch {
      return false;
    }
  }

  return { createPreRunSnapshot, refreshSnapshot, restoreFromSnapshot, captureFiles, readIndex };
}

export type SnapshotManager = ReturnType<typeof createSnapshotManager>;
