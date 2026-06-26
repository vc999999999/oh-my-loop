/**
 * state-store —— .loop/state.json 的读写(可恢复性地基)。
 *
 * - load:不存在→init;损坏→备份 state.json.corrupt-<ts> 并返回 corrupt,绝不静默续跑。
 * - persist:写 .tmp 再 rename(原子,抄 simple-memory)。kill -9 任意时刻 state.json 都完整。
 *
 * 复用 schema/state.ts 的 parseLoopState(Zod 校验后才信任)。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  LoopState_File,
  parseLoopState,
  SCHEMA_VERSION,
  type LoopState_File as LoopStateFile,
  type AutonomyPolicy,
  type Budget,
} from "./schema/state.ts";

export type InitArgs = {
  goalStatement: string;
  mode: string;
  autonomy: AutonomyPolicy;
  budget: Budget;
};

export type LoadResult =
  | { kind: "loaded"; state: LoopStateFile }
  | { kind: "absent" }
  | { kind: "corrupt"; errors: string[]; backupPath: string };

export function createStateStore(loopDir: string) {
  const statePath = join(loopDir, "state.json");
  const tmpPath = join(loopDir, "state.json.tmp");

  function load(): LoadResult {
    if (!existsSync(statePath)) return { kind: "absent" };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (e) {
      // 非法 JSON —— 损坏。备份后上报,不静默。
      const backupPath = backupCorrupt();
      return { kind: "corrupt", errors: [`invalid JSON: ${(e as Error).message}`], backupPath };
    }
    const parsed = parseLoopState(raw);
    if (!parsed.ok) {
      const backupPath = backupCorrupt();
      return { kind: "corrupt", errors: parsed.errors, backupPath };
    }
    return { kind: "loaded", state: parsed.data };
  }

  function backupCorrupt(): string {
    const backupPath = join(loopDir, `state.json.corrupt-${stamp()}`);
    try {
      copyFileSync(statePath, backupPath);
    } catch {
      /* best-effort */
    }
    return backupPath;
  }

  function init(args: InitArgs): LoopStateFile {
    const now = new Date().toISOString();
    const state: LoopStateFile = LoopState_File.parse({
      schemaVersion: SCHEMA_VERSION,
      goal: {
        id: `goal-${stamp()}`,
        statement: args.goalStatement,
        mode: args.mode,
        createdAt: now,
        doneWhen: [],
      },
      state: "trigger",
      autonomy: args.autonomy,
      budget: args.budget,
      units: [],
      activeUnitId: null,
      escalationIds: [],
      updatedAt: now,
    });
    persist(state);
    return state;
  }

  /** 原子写:.tmp → rename。先校验再写,绝不落盘非法 state。 */
  function persist(state: LoopStateFile): void {
    mkdirSync(loopDir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    const validated = LoopState_File.parse(state); // 落盘前自检
    writeFileSync(tmpPath, JSON.stringify(validated, null, 2), "utf8");
    renameSync(tmpPath, statePath); // 原子替换
  }

  return { load, init, persist, statePath };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type StateStore = ReturnType<typeof createStateStore>;
