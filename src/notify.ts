/**
 * notify —— escalation 的真·告警通道(不只是静默写文件)。
 *
 * 框架要求:异常退出时「挂起并报警(Notify)」。控制器原本只把 escalation 写进
 * .loop/escalations/<id>.json,人不盯着目录就发现不了。这里给 escalate 加一个
 * 可配置出口:默认喊到 stderr(配合 cli 退出码 2),并留 webhook 接口(Slack/钉钉/自建)。
 *
 * 所有 notifier 都是 best-effort、fire-and-forget:告警失败绝不拖垮主 loop。
 */

export type NotifyPayload = {
  id: string;
  reason: string;
  risk: "low" | "medium" | "high";
  humanQuestion: string;
  unitId: string | null;
  loopDir: string;
};

export type Notifier = (p: NotifyPayload) => void;

/** 默认:把 escalation 喊到 stderr。配合 cli 的退出码 2 = 真·报警,不再静默。 */
export const stderrNotifier: Notifier = (p) => {
  process.stderr.write(
    `\n🚨 ESCALATION [${p.risk}] ${p.reason} — ${p.humanQuestion}\n` +
      `   id=${p.id}${p.unitId ? ` unit=${p.unitId}` : ""}  → ${p.loopDir}/escalations/${p.id}.json\n`,
  );
};

/** webhook:POST 到 url(Slack incoming-webhook / 钉钉 / 自建均可)。失败静默。 */
export function webhookNotifier(url: string): Notifier {
  return (p) => {
    try {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `🚨 [${p.risk}] ${p.reason}: ${p.humanQuestion} (${p.id}${p.unitId ? ` / ${p.unitId}` : ""})`,
          ...p,
        }),
      }).catch(() => {
        /* best-effort */
      });
    } catch {
      /* fetch 不可用等:静默 */
    }
  };
}

/** 串联多个 notifier(如 stderr + webhook 同时发)。任一失败不影响其它。 */
export function multiNotifier(...notifiers: Notifier[]): Notifier {
  return (p) => {
    for (const n of notifiers) {
      try {
        n(p);
      } catch {
        /* 隔离单个 notifier 的失败 */
      }
    }
  };
}
