/**
 * safety —— 控制器层安全门(fail-closed)。
 *
 * 来源:CC Safety Net(PreToolUse、fail-closed、rulebooks)+ Envsitter(.env 防护)。
 * 分工:
 *   - opencode session 内部的工具调用 → 由已装插件 cc-safety-net / envsitter-guard 拦(tool.execute.before)。
 *   - 控制器自己跑的 shell(gate 命令、integrate 的 git)→ 由本模块在执行前筛查。
 * fail-closed:拿不准就拦。宁可漏报可用命令,不可放过破坏性命令。
 */

/** 破坏性命令模式(保守、宁严勿松)。 */
const DESTRUCTIVE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: "rm -rf" },
  { re: /\brm\s+-[a-z]*\s+(\/|~|\$HOME)\b/i, reason: "rm 根/家目录" },
  { re: /\b(mkfs|dd)\s+/i, reason: "磁盘级操作" },
  { re: /:\(\)\s*\{.*\}\s*;/, reason: "fork bomb" },
  { re: /\bgit\s+push\b.*(--force|-f)\b/i, reason: "git force push" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { re: /\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+clean\s+-[a-z]*d[a-z]*f/i, reason: "git clean -fd(全树)" },
  { re: />\s*\/dev\/sd[a-z]/i, reason: "写裸设备" },
  { re: /\bchmod\s+-R\s+777\s+\//i, reason: "chmod 777 /" },
  { re: /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "curl | sh 远程执行" },
  { re: /\bsudo\b/i, reason: "sudo 提权" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "关机/重启" },
];

/** .env / 密钥文件读写(envsitter 同类防护)。 */
const SECRET_FILE_PATTERN = /(^|[\s/"'])\.env(\.[a-z]+)?\b|\bid_rsa\b|\bcredentials\b/i;

export type ScreenResult = { safe: boolean; reason?: string };

/** 筛查一条要执行的 shell 命令。fail-closed。 */
export function screenCommand(command: string): ScreenResult {
  const cmd = command.trim();
  if (!cmd) return { safe: true };
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(cmd)) return { safe: false, reason: p.reason };
  }
  // 写 .env(读取不拦,写入/删除拦)
  if (SECRET_FILE_PATTERN.test(cmd) && /(>|>>|\brm\b|\bmv\b|\bcp\b.*\.env)/.test(cmd)) {
    return { safe: false, reason: "改写密钥文件" };
  }
  return { safe: true };
}

/** 批量筛查;任一不安全则整体不安全(返回第一个原因)。 */
export function screenAll(commands: string[]): ScreenResult {
  for (const c of commands) {
    const r = screenCommand(c);
    if (!r.safe) return r;
  }
  return { safe: true };
}
