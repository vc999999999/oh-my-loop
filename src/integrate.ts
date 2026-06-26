/**
 * integrate —— 按自治等级决定怎么落地一个完成的 unit。
 *
 * 来源:loop-engineering 放权阶梯 + cortex/Plannotator。
 *   - none(L1):不合并,只记录(只读模式)。
 *   - propose(L2):写提案 → escalate 待人批准。
 *   - auto(L3):白名单内自动 merge;越白名单 → 退化成 propose。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeWorktree, changedFiles, diffSummary } from "./worktree.ts";
import type { LoopState_File, Unit } from "./schema/state.ts";

export type IntegrateOutcome =
  | { kind: "recorded" } // L1
  | { kind: "proposed"; proposalPath: string } // L2
  | { kind: "merged"; output: string } // L3
  | { kind: "conflict"; output: string } // 合并冲突
  | { kind: "out_of_allowlist"; offending: string[]; proposalPath: string }; // L3 越白名单

/** 改动是否全部落在白名单 glob 前缀内。 */
function withinAllowlist(files: string[], allowlist: string[]): { ok: boolean; offending: string[] } {
  if (!allowlist.length) return { ok: false, offending: files }; // 空白名单 = 没有任何东西可自动放行
  const offending = files.filter((f) => {
    const n = f.replace(/\\/g, "/");
    return !allowlist.some((a) => n.startsWith(a.replace(/\\/g, "/")));
  });
  return { ok: offending.length === 0, offending };
}

export function integrateUnit(
  state: LoopState_File,
  unit: Unit,
  opts: { root: string; baseBranch?: string },
): IntegrateOutcome {
  const action = state.autonomy.integrateAction;

  if (action === "none") return { kind: "recorded" };

  const workdir = unit.worktree ?? opts.root;
  const base = opts.baseBranch ?? "HEAD";
  const files = unit.worktree ? changedFiles(unit.worktree, base) : [];

  if (action === "propose") {
    return { kind: "proposed", proposalPath: writeProposal(opts.root, unit, files) };
  }

  // action === "auto"(L3):白名单校验
  const check = withinAllowlist(files, state.autonomy.allowlistPaths);
  if (!check.ok) {
    return {
      kind: "out_of_allowlist",
      offending: check.offending,
      proposalPath: writeProposal(opts.root, unit, files),
    };
  }
  if (!unit.worktree) return { kind: "recorded" };
  const merge = mergeWorktree(opts.root, unit.id, opts.baseBranch);
  if (merge.conflict) return { kind: "conflict", output: merge.output };
  if (!merge.merged) return { kind: "conflict", output: merge.output };
  return { kind: "merged", output: merge.output };
}

function writeProposal(root: string, unit: Unit, files: string[]): string {
  const dir = join(root, ".loop", "proposals");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${unit.id}.md`);
  const diff = unit.worktree ? diffSummary(unit.worktree, "HEAD") : "";
  writeFileSync(
    path,
    [
      `# Proposal — ${unit.id}`,
      ``,
      `> ${unit.title}`,
      `> worktree: \`${unit.worktree ?? "(none)"}\``,
      ``,
      `## 改动文件 (${files.length})`,
      files.length ? files.map((f) => `- ${f}`).join("\n") : "_无_",
      ``,
      `## diff 规模`,
      diff || "_n/a_",
      ``,
      `等待人批准后 merge。`,
    ].join("\n"),
    "utf8",
  );
  return path;
}
