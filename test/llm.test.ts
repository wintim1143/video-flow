import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 隔离一切真实凭据：把配置解析整体 mock 掉，测试绝不读项目根的 llm.config.json。
 */
vi.mock("@/lib/llm-configs", () => ({
  resolveProfile: () => ({
    id: "test-profile",
    name: "Test Profile",
    baseURL: "https://llm.test/v1",
    apiKey: "test-key",
    model: "test-model",
  }),
}));

import { chatJSON, extractJson, LLMError } from "@/lib/llm";

const Schema = z.object({ a: z.number() });

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const chatOk = (content: string) =>
  jsonRes(200, {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });

/** 按顺序返回预设响应；用尽后抛错，便于断言调用次数 */
function mockFetchSeq(seq: Array<() => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const next = seq.shift();
    if (!next) throw new Error(`fetch 被多调用了：第 ${calls.length} 次`);
    return next();
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractJson", () => {
  it("裸 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("```json 围栏", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("无语言标记的围栏", () => {
    expect(extractJson("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("前后废话", () => {
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toEqual({ a: 1 });
  });

  it("嵌套对象按最外层括号截取", () => {
    expect(extractJson('{"a":{"b":{"c":2}}}')).toEqual({ a: { b: { c: 2 } } });
  });

  it("非法内容抛错", () => {
    expect(() => extractJson("完全不是 JSON")).toThrow();
  });
});

describe("chatJSON 退避重试（429 / 5xx）", () => {
  it("429 后成功：重试一次即拿到结果，不触发降级", async () => {
    const { fn, calls } = mockFetchSeq([
      () => jsonRes(429, { error: "rate limit" }, { "retry-after": "0" }),
      () => chatOk('{"a":1}'),
    ]);

    const r = await chatJSON({ system: "s", user: "u", schema: Schema });
    expect(r.data).toEqual({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
    // 重试时参数保持不变（jsonMode 仍在）
    expect(calls[1].body.response_format).toEqual({ type: "json_object" });
  });

  it("503 连续两次后成功：共 3 次调用（MAX_ATTEMPTS=3）", async () => {
    const { fn } = mockFetchSeq([
      () => jsonRes(503, { error: "unavailable" }),
      () => jsonRes(502, { error: "bad gateway" }),
      () => chatOk('{"a":2}'),
    ]);

    const r = await chatJSON({ system: "s", user: "u", schema: Schema });
    expect(r.data).toEqual({ a: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("429 一直失败时最终抛出 UPSTREAM，且不无限重试", async () => {
    const { fn } = mockFetchSeq([
      () => jsonRes(429, { error: "rate limit" }),
      () => jsonRes(429, { error: "rate limit" }),
      () => jsonRes(429, { error: "rate limit" }),
      () => jsonRes(429, { error: "rate limit" }),
    ]);

    await expect(chatJSON({ system: "s", user: "u", schema: Schema })).rejects.toMatchObject({
      code: "UPSTREAM",
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("chatJSON 降级重试（4xx 参数问题）", () => {
  it("401 不重试，立即失败", async () => {
    const { fn } = mockFetchSeq([() => jsonRes(401, { error: "bad key" })]);
    await expect(chatJSON({ system: "s", user: "u", schema: Schema })).rejects.toMatchObject({
      code: "UPSTREAM",
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("报错点名 response_format 时剥离该参数重试", async () => {
    const { fn, calls } = mockFetchSeq([
      () => jsonRes(400, { error: "response_format is unsupported" }),
      () => chatOk('{"a":3}'),
    ]);

    const r = await chatJSON({ system: "s", user: "u", schema: Schema });
    expect(r.data).toEqual({ a: 3 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[0].body.response_format).toBeTruthy();
    expect(calls[1].body.response_format).toBeUndefined();
  });

  it("不带参数名的通用 400：逐级剥离 response_format 与 reasoning_effort", async () => {
    const { fn, calls } = mockFetchSeq([
      () => jsonRes(400, { error: "invalid_request", message: "参数错误" }),
      () => jsonRes(400, { error: "invalid_request", message: "参数错误" }),
      () => chatOk('{"a":4}'),
    ]);

    const r = await chatJSON({ system: "s", user: "u", schema: Schema });
    expect(r.data).toEqual({ a: 4 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(calls[0].body.response_format).toBeTruthy();
    expect(calls[0].body.reasoning_effort).toBe("minimal");
    expect(calls[1].body.response_format).toBeUndefined();
    expect(calls[2].body.reasoning_effort).toBeUndefined();
  });
});

describe("chatJSON 输出解析", () => {
  it("schema 不匹配抛 PARSE", async () => {
    mockFetchSeq([() => chatOk('{"a":"不是数字"}')]);
    await expect(chatJSON({ system: "s", user: "u", schema: Schema })).rejects.toMatchObject({
      code: "PARSE",
    });
  });

  it("非 JSON 输出抛 PARSE", async () => {
    mockFetchSeq([() => chatOk("我不知道")]);
    await expect(chatJSON({ system: "s", user: "u", schema: Schema })).rejects.toMatchObject({
      code: "PARSE",
    });
  });

  it("成功时返回 raw 与 usage", async () => {
    mockFetchSeq([() => chatOk('{"a":9}')]);
    const r = await chatJSON({ system: "s", user: "u", schema: Schema });
    expect(r.raw).toBe('{"a":9}');
    expect(r.usage?.total_tokens).toBe(3);
  });

  it("带图时走 vision 的 parts 结构", async () => {
    const { calls } = mockFetchSeq([() => chatOk('{"a":1}')]);
    await chatJSON({ system: "s", user: "看图", schema: Schema, imageUrl: "data:image/jpeg;base64,AAA" });
    const msgs = calls[0].body.messages as Array<{ role: string; content: unknown }>;
    expect(Array.isArray(msgs[1].content)).toBe(true);
    expect((msgs[1].content as Array<{ type: string }>)[0].type).toBe("image_url");
  });
});

describe("trace 埋点：重试次数被记录", () => {
  it("429 重试后写入的日志里 retries=1、attempts=2", async () => {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "vf-llm-trace-"));
    process.env.TRACE_LOG_DIR = dir;

    try {
      mockFetchSeq([
        () => jsonRes(429, { error: "rate limit" }, { "retry-after": "0" }),
        () => chatOk('{"a":1}'),
      ]);
      await chatJSON({
        system: "s",
        user: "u",
        schema: Schema,
        trace: { traceId: "t-test", step: "outline" },
      });

      const file = pathMod.join(dir, fs.readdirSync(dir)[0]);
      const logged = JSON.parse(fs.readFileSync(file, "utf8").trim());
      expect(logged.traceId).toBe("t-test");
      expect(logged.step).toBe("outline");
      expect(logged.attempts).toBe(2);
      expect(logged.retries).toBe(1);
      expect(logged.ok).toBe(true);
    } finally {
      delete process.env.TRACE_LOG_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LLMError", () => {
  it("保留 status 与 retryAfterMs", () => {
    const e = new LLMError("UPSTREAM", "boom", "detail", 429, 1500);
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(1500);
    expect(e).toBeInstanceOf(Error);
  });
});
