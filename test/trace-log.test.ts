import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTrace,
  exportFineTune,
  monthFileName,
  newTraceId,
  readTraces,
  traceLogDir,
  type TraceRecord,
} from "@/lib/trace-log";

/**
 * 硬规则：所有 fixture 一律落在 /tmp，绝不在项目根写/删任何文件。
 * vitest.config.ts 已把 TRACE_LOG_DIR 指到 /tmp，这里每个用例再指向独立临时目录。
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-trace-"));
  process.env.TRACE_LOG_DIR = dir;
});

afterEach(() => {
  delete process.env.TRACE_LOG_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function rec(partial: Partial<TraceRecord> & { traceId: string; step: string }): Omit<TraceRecord, "id" | "ts"> {
  return {
    model: "test-model",
    profileId: "p1",
    profileName: "测试",
    temperature: 0.7,
    hasImage: false,
    attempts: 1,
    degraded: [],
    ok: true,
    latencyMs: 123,
    system: "sys",
    user: "usr",
    ...partial,
  };
}

describe("traceLogDir / monthFileName", () => {
  it("TRACE_LOG_DIR 优先生效", () => {
    expect(traceLogDir()).toBe(dir);
  });

  it("按月命名，月份补零", () => {
    expect(monthFileName(new Date("2026-09-12T00:00:00Z"))).toBe("traces-2026-09.jsonl");
    expect(monthFileName(new Date("2026-01-05T00:00:00Z"))).toBe("traces-2026-01.jsonl");
  });

  it("newTraceId 唯一", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTraceId()));
    expect(ids.size).toBe(200);
  });
});

describe("appendTrace / readTraces", () => {
  it("写入后能读回，且按新→旧排序", () => {
    appendTrace(rec({ traceId: "t1", step: "outline" }));
    appendTrace(rec({ traceId: "t1", step: "shot_1" }));
    appendTrace(rec({ traceId: "t2", step: "style" }));

    const all = readTraces();
    expect(all).toHaveLength(3);
    expect(all[0].step).toBe("style"); // 最后写入的在最前
    expect(all[2].step).toBe("outline");
  });

  it("自动补 id / ts", () => {
    appendTrace(rec({ traceId: "t1", step: "outline" }));
    const [r] = readTraces();
    expect(r.id).toBeTruthy();
    expect(new Date(r.ts).toString()).not.toBe("Invalid Date");
  });

  it("limit 截断，只返回最新的 N 条", () => {
    for (let i = 0; i < 10; i++) appendTrace(rec({ traceId: "t1", step: `shot_${i}` }));
    const got = readTraces(3);
    expect(got).toHaveLength(3);
    expect(got[0].step).toBe("shot_9");
    expect(got[2].step).toBe("shot_7");
  });

  it("尾部字节预算生效时丢弃半行且仍返回完整记录", () => {
    for (let i = 0; i < 50; i++) {
      appendTrace(rec({ traceId: "t1", step: `s${i}`, raw: "x".repeat(200) }));
    }
    // 只读 600 字节：必然从半行开始，但返回的记录必须条条可解析
    const got = readTraces(500, 600);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(50);
    for (const r of got) expect(r.step).toMatch(/^s\d+$/);
  });

  it("坏行被跳过，不炸整次读取", () => {
    appendTrace(rec({ traceId: "t1", step: "good1" }));
    fs.appendFileSync(path.join(dir, monthFileName()), "{这不是JSON\n", "utf8");
    appendTrace(rec({ traceId: "t1", step: "good2" }));
    const got = readTraces();
    expect(got.map((r) => r.step)).toEqual(["good2", "good1"]);
  });

  it("兼容改造前的单文件 traces.jsonl", () => {
    const legacy: TraceRecord = {
      ...rec({ traceId: "old", step: "legacy" }),
      id: "x",
      ts: new Date().toISOString(),
    } as TraceRecord;
    fs.writeFileSync(path.join(dir, "traces.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const got = readTraces();
    expect(got).toHaveLength(1);
    expect(got[0].step).toBe("legacy");
  });

  it("目录为空时不报错，返回空数组", () => {
    expect(readTraces()).toEqual([]);
  });
});

describe("exportFineTune", () => {
  it("只导出成功且有 raw 的记录，格式为 messages + completion", () => {
    const ok = {
      ...rec({ traceId: "t1", step: "outline" }),
      id: "1",
      ts: "2026-09-12T00:00:00.000Z",
      raw: '{"a":1}',
    } as TraceRecord;
    const failed = {
      ...rec({ traceId: "t1", step: "shot_1", ok: false, raw: undefined }),
      id: "2",
      ts: "2026-09-12T00:00:01.000Z",
    } as TraceRecord;

    const out = exportFineTune([ok, failed]);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    expect(parsed.completion).toBe('{"a":1}');
    expect(parsed.meta.step).toBe("outline");
  });

  it("无可用记录时返回空串", () => {
    expect(exportFineTune([])).toBe("");
  });
});

describe("写入失败不影响主链路", () => {
  it("目录不可写时静默降级（不抛错）", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    process.env.TRACE_LOG_DIR = "/proc/definitely-not-writable/vf";
    expect(() => appendTrace(rec({ traceId: "t", step: "s" }))).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
