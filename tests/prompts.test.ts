/**
 * prompts.test —— 行为准则 prompt 组装的契约测试。
 *
 * 测的是机制耦合,不是文案:CONDUCT 稳定前缀(缓存命中前提)、
 * scope/lastError 注入、verifier JSON 契约与 verify.parseAndValidate 兼容。
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { CONDUCT, explorePrompt, implementPrompt, verifierPrompt } from "../src/prompts.ts";
import { parseAndValidate } from "../src/verify.ts";
import { runSession } from "../src/opencode-runner.ts";

describe("CONDUCT 公共前缀", () => {
  test("explore 与 implement 共享完全一致的前缀(上下文缓存前提)", () => {
    const e = explorePrompt("任务A");
    const i = implementPrompt({ instruction: "任务B", scope: ["src/"] });
    expect(e.startsWith(CONDUCT)).toBe(true);
    expect(i.startsWith(CONDUCT)).toBe(true);
  });

  test("包含五条核心契约的关键约束", () => {
    expect(CONDUCT).toContain("禁止向用户提问");
    expect(CONDUCT).toContain("最后一条消息");
    expect(CONDUCT).toContain("如实汇报");
    expect(CONDUCT).toContain("严禁 git commit / push");
  });
});

describe("explorePrompt", () => {
  test("注入任务指令且声明只读", () => {
    const p = explorePrompt("给 CLI 加 --json 输出");
    expect(p).toContain("给 CLI 加 --json 输出");
    expect(p).toContain("严禁修改任何文件");
  });
});

describe("implementPrompt", () => {
  test("注入 scope 清单与越界后果", () => {
    const p = implementPrompt({ instruction: "x", scope: ["src/", "tests/"] });
    expect(p).toContain("src/, tests/");
    expect(p).toContain("回滚");
  });

  test("空 scope 显示(无限制)", () => {
    expect(implementPrompt({ instruction: "x", scope: [] })).toContain("(无限制)");
  });

  test("lastError 存在时注入修复上下文,否则不出现", () => {
    const withErr = implementPrompt({ instruction: "x", scope: [], lastError: "gate: tsc 报错 TS2304" });
    expect(withErr).toContain("gate: tsc 报错 TS2304");
    expect(withErr).toContain("必须优先修复");
    const noErr = implementPrompt({ instruction: "x", scope: [], lastError: null });
    expect(noErr).not.toContain("必须优先修复");
  });
});

describe("verifierPrompt", () => {
  test("注入 criterion 与改动文件;空文件列表显示(未知)", () => {
    const p = verifierPrompt("tsc 通过", ["src/a.ts"]);
    expect(p).toContain("tsc 通过");
    expect(p).toContain("src/a.ts");
    expect(verifierPrompt("c", [])).toContain("(未知)");
  });

  test("要求的 JSON 输出形状能被 verify.parseAndValidate 接受", () => {
    // prompt 里给模型的示例契约:{"verdict":"pass"|"fail","gates":[]}
    const pass = parseAndValidate('{"verdict":"pass","gates":[]}');
    const fail = parseAndValidate('{"verdict":"fail","gates":[]}');
    expect(pass.valid).toBe(true);
    expect(fail.valid).toBe(true);
  });

  test("保持证伪立场与 fail 兜底指令", () => {
    const p = verifierPrompt("c", []);
    expect(p).toContain("REFUTE");
    expect(p).toContain('{"verdict":"fail"}');
    expect(p).toContain("严禁修改任何文件");
  });
});

describe("prompt → opencode argv 完整性", () => {
  test("多行中文 prompt(含引号/换行)原样作为单个 argv 传给 opencode run", async () => {
    const prompt = implementPrompt({
      instruction: '实现 "特殊引号" 与\n换行的任务',
      scope: ["src/"],
      lastError: "gate `tsc` 报错",
    });

    let captured: { cmd: string; args: string[] } | null = null;
    function fakeSpawn(cmd: string, args: string[]): any {
      captured = { cmd, args };
      const child: any = new EventEmitter();
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.push('{"type":"text","part":{"text":"done"}}\n');
        child.stdout.push('{"type":"step_finish","part":{"cost":0.01,"tokens":{"input":1,"output":1},"reason":"stop"}}\n');
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      });
      return child;
    }

    const r = await runSession({
      prompt,
      cwd: "/tmp",
      deadManMs: 5_000,
      wallClockMs: 10_000,
      spawnImpl: fakeSpawn as any,
    });

    expect(captured!.cmd).toBe("opencode");
    // argv[1] 就是完整 prompt:spawn 数组传参,无 shell 插值,换行/引号必须原样保留
    expect(captured!.args[0]).toBe("run");
    expect(captured!.args[1]).toBe(prompt);
    expect(captured!.args[1]).toContain(CONDUCT);
    expect(captured!.args).toContain("--format");
    expect(r.signal).toBe("cycle_complete");
    expect(r.finalText).toBe("done");
  });
});
