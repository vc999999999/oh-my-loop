/**
 * verify —— cycle 输出 Zod 校验 + 保守默认(防 malformed verifier)。
 *
 * 来源:cortex cycle-schemas.mjs validateCycleOutput / CONSERVATIVE_DEFAULTS。
 * verifier 自己可能产坏 JSON → 先校验再信任;校验失败用保守默认,偏向「假定失败」。
 *
 * Phase 0 happy path 不跑验证门(只读 triage),但故障注入 test 8 直接驱动本模块。
 */

import { z } from "zod";

/** 一个 verify cycle 的输出形状(简化:verdict + 证据)。 */
export const VerifyReport = z.object({
  verdict: z.enum(["pass", "fail", "uncheckable", "invalid"]),
  gates: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(["pass", "fail", "uncheckable", "invalid"]),
        measured: z.string().optional(),
        negativeControlFailed: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

/** 保守默认:坏 verifier 输出 = 不可信 = 当失败(invalid)。 */
export const CONSERVATIVE_DEFAULT: VerifyReport = { verdict: "invalid" };

export type ValidateResult =
  | { valid: true; data: VerifyReport }
  | { valid: false; errors: string[]; fallback: VerifyReport };

/** 校验 verifier 输出;失败返回保守默认(偏 fail/invalid)。 */
export function validateVerifyOutput(raw: unknown): ValidateResult {
  const result = VerifyReport.safeParse(raw);
  if (result.success) return { valid: true, data: result.data };
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    fallback: CONSERVATIVE_DEFAULT,
  };
}

/** 解析 JSON 字符串 → 校验。非法 JSON 也走保守默认。 */
export function parseAndValidate(rawJson: string): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      valid: false,
      errors: [`invalid JSON: ${(e as Error).message}`],
      fallback: CONSERVATIVE_DEFAULT,
    };
  }
  return validateVerifyOutput(parsed);
}

/**
 * gate 的 negative control 自检:check 在 repo 上 pass 且 negative control 没 FAIL
 * → invalid(不区分的坏温度计)。来源:harness-audit verifier-protocol.md:56。
 */
export function gateVerdictWithNegativeControl(
  repoPassed: boolean,
  negativeControlFailed: boolean,
): "pass" | "fail" | "invalid" {
  if (!repoPassed) return "fail";
  if (!negativeControlFailed) return "invalid"; // 跑了但撒谎
  return "pass";
}
