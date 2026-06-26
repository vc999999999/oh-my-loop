/**
 * journal —— append-only ndjson 审计轨。
 *
 * 来源:simple-memory(append-only + daily sharding)+ meguri(timeline.ndjson)。
 * 优化 O2:journal 先写、state.json 后写。恢复时以 state.json 为准,
 * journal 多出的尾条 = 未确认完成的转移,重启幂等重跑。
 *
 * 每条 = 一次状态转移 / 一个事件,一行 JSON。既是审计源,也是 otel 导出源。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type JournalEntry = {
  ts: string;
  state?: string;
  unit?: string | null;
  cycle?: string | null;
  signal?: string;
  reason?: string;
  event: string;
  detail?: Record<string, unknown>;
};

/** 当天分片文件名:journal/<YYYY-MM-DD>.ndjson。 */
function shardPath(journalDir: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(journalDir, `${day}.ndjson`);
}

export function createJournal(loopDir: string) {
  const journalDir = join(loopDir, "journal");

  function append(entry: Omit<JournalEntry, "ts"> & { ts?: string }): void {
    mkdirSync(journalDir, { recursive: true });
    const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
    // 一行一条,append-only。flush 同步写,保证 kill -9 前已落盘。
    appendFileSync(shardPath(journalDir, new Date(full.ts)), JSON.stringify(full) + "\n", "utf8");
  }

  return { append, journalDir };
}

export type Journal = ReturnType<typeof createJournal>;
