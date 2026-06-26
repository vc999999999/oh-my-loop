/**
 * progress —— 进度指纹 + 错误指纹(供 stop-conditions 的进展类 predicate)。
 *
 * 优化 O3:进度指纹用 git diff --stat 累计字节 + 单元状态,而非行数,
 *   避免「反复改同几行」骗过 noProgress。错误指纹归一化去噪后 hash。
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { LoopState_File } from "./schema/state.ts";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/**
 * 进度指纹:units 状态 + 每单元 cycle 完成度 + diff 规模。连续相同 = 无进展。
 * 关键:完成一个 cycle 本身就是进展(只读模式不产生 diff,必须靠 cycle 完成度体现),
 * 否则只读 triage 会被 noProgress 误判。
 */
export function progressFingerprint(state: LoopState_File, root: string): string {
  const unitStates = state.units
    .map((u) => {
      const done = u.cycles.filter((c) => c.status === "done").length;
      return `${u.id}:${u.status}:${done}/${u.cycles.length}`;
    })
    .join(",");
  let diffStat = "";
  try {
    diffStat = execSync("git diff --shortstat HEAD", { cwd: root, stdio: "pipe" }).toString().trim();
  } catch {
    /* 非 git 或无 diff */
  }
  return sha1(`${unitStates}|${diffStat}`);
}

/** 错误指纹:去掉时间戳/路径/行号噪音后 hash,用于 sameErrorRepeats。 */
export function errorFingerprint(error: string | undefined | null): string {
  if (!error) return "";
  const normalized = error
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, "<ts>") // 时间戳
    .replace(/\/[^\s:]+/g, "<path>") // 绝对路径
    .replace(/:\d+:\d+/g, ":<pos>") // 行列号
    .replace(/0x[0-9a-f]+/gi, "<addr>") // 地址
    .trim();
  return sha1(normalized);
}
