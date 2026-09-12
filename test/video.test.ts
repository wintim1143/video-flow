import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 隔离真实凭据：整体 mock 配置解析，测试绝不读项目根的 llm.config.json。
 * vi.hoisted 保证 state 在 mock 工厂之前初始化。
 */
const state = vi.hoisted(() => ({
  profile: null as null | {
    id: string;
    name: string;
    baseURL: string;
    apiKey: string;
    model: string;
    provider?: string;
    mode?: string;
  },
}));

vi.mock("@/lib/llm-configs", () => ({
  resolveProfile: () => state.profile,
}));

import {
  VideoError,
  createVideoTask,
  queryVideoTask,
} from "@/lib/video";
import { resetVideoGate, markVideoCall, videoGateSnapshot } from "@/lib/video-rate-limit";

const AGNES = {
  id: "v1",
  name: "Agnes Video 2.5 Flash",
  baseURL: "https://api.agnes-ai.cn/v1",
  apiKey: "test-key",
  model: "agnes-video-2.5-flash",
};

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(String(url), init);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

beforeEach(() => {
  state.profile = { ...AGNES };
  resetVideoGate();
  process.env.VIDEO_CREATE_MIN_INTERVAL_MS = "60000";
  process.env.VIDEO_QUERY_MIN_INTERVAL_MS = "4000";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIDEO_CREATE_MIN_INTERVAL_MS;
  delete process.env.VIDEO_QUERY_MIN_INTERVAL_MS;
});

describe("createVideoTask", () => {
  it("打到适配器算出的 URL，带 Bearer，body 由适配器生成", async () => {
    const { calls } = mockFetch(() =>
      jsonRes(200, { id: "task_1", task_id: "task_1", video_id: "video_1", status: "queued", progress: 0 })
    );

    const r = await createVideoTask({ prompt: "一只猫", seconds: 5, aspectRatio: "16:9" });

    expect(calls[0].url).toBe("https://api.agnes-ai.cn/v1/videos");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(calls[0].body).toMatchObject({ mode: "text", seconds: "5", size: "720P", aspect_ratio: "16:9" });
    expect(r.taskId).toBe("video_1");
    expect(r.status).toBe("queued");
    expect(r.provider).toBe("agnes");
    expect(r.mode).toBe("text");
  });

  it("上游没给任何 ID → 明确报错，而不是返回一个查不了的任务", async () => {
    mockFetch(() => jsonRes(200, { status: "queued" }));
    await expect(createVideoTask({ prompt: "x" })).rejects.toThrowError(VideoError);
  });

  it("未配置 video profile → CONFIG_MISSING", async () => {
    state.profile = null;
    await expect(createVideoTask({ prompt: "x" })).rejects.toMatchObject({ code: "CONFIG_MISSING" });
  });

  it("上游 429：把 Retry-After 转成 retryAfterMs 透出", async () => {
    mockFetch(() => jsonRes(429, { detail: "rate limited" }, { "retry-after": "42" }));
    try {
      await createVideoTask({ prompt: "x" });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as VideoError;
      expect(err.code).toBe("UPSTREAM");
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(42_000);
    }
  });

  it("上游 429 且没有 Retry-After：退回本地最小间隔作为等待建议", async () => {
    mockFetch(() => jsonRes(429, {}));
    try {
      await createVideoTask({ prompt: "x" });
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as VideoError).retryAfterMs).toBe(60_000);
    }
  });
});

describe("queryVideoTask", () => {
  it("走适配器的查询 URL（Agnes 是 /agnesapi?query），completed 时取 metadata.url", async () => {
    const { calls } = mockFetch(() =>
      jsonRes(200, { status: "completed", progress: 100, metadata: { url: "https://x/v.mp4" } })
    );

    const r = await queryVideoTask({ taskId: "video_1" });

    expect(calls[0].url).toBe(
      "https://api.agnes-ai.cn/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash"
    );
    expect(r.status).toBe("completed");
    expect(r.videoUrl).toBe("https://x/v.mp4");
  });

  it("进行中：没有 videoUrl，带 progress", async () => {
    mockFetch(() => jsonRes(200, { status: "in_progress", progress: 30 }));
    const r = await queryVideoTask({ taskId: "video_1" });
    expect(r.status).toBe("running");
    expect(r.progress).toBe(30);
    expect(r.videoUrl).toBeUndefined();
  });
});

describe("限流闸门（生成与查询互相独立）", () => {
  it("回归：刚建完任务，查询**不受**生成配额影响，可以立刻查", async () => {
    const { fn } = mockFetch((url) =>
      url.includes("/agnesapi")
        ? jsonRes(200, { status: "in_progress", progress: 10 })
        : jsonRes(200, { video_id: "video_1", status: "queued" })
    );

    await createVideoTask({ prompt: "x" });
    /* 这一步在早期版本会被 60s 的建任务闸门连坐拦下 —— 5 秒的视频要等一分钟才看得到结果 */
    const q = await queryVideoTask({ taskId: "video_1" });

    expect(q.status).toBe("running");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("生成配额只约束建任务：第二次建任务被本地拦下，且不发上游请求", async () => {
    const { fn } = mockFetch(() => jsonRes(200, { video_id: "video_1", status: "queued" }));

    await createVideoTask({ prompt: "a" });
    expect(fn).toHaveBeenCalledTimes(1);

    try {
      await createVideoTask({ prompt: "b" });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as VideoError;
      expect(err.code).toBe("THROTTLED");
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
    /* 关键：被闸门拦下时一次上游请求都没发出去 */
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("查询闸门宽松得多（默认 4s），不是生成配额那个量级", async () => {
    const { fn } = mockFetch(() => jsonRes(200, { status: "in_progress", progress: 10 }));

    await queryVideoTask({ taskId: "v" });
    try {
      await queryVideoTask({ taskId: "v" });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as VideoError;
      expect(err.code).toBe("THROTTLED");
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.retryAfterMs).toBeLessThanOrEqual(4_000);
      /* 关键：查询侧的等待必须远小于生成侧 —— 否则又回到「建完等一分钟」 */
      expect(err.retryAfterMs).toBeLessThan(60_000);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("VIDEO_CREATE_MIN_INTERVAL_MS=0 时生成闸门关闭（本地开发 / 自建网关场景）", async () => {
    process.env.VIDEO_CREATE_MIN_INTERVAL_MS = "0";
    const { fn } = mockFetch(() => jsonRes(200, { video_id: "v", status: "queued" }));

    await createVideoTask({ prompt: "a" });
    await createVideoTask({ prompt: "b" });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("生成配额耗尽后等待期满即可再次调用", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = mockFetch(() => jsonRes(200, { video_id: "v", status: "queued" }));
      await createVideoTask({ prompt: "a" });
      vi.advanceTimersByTime(60_001);
      await createVideoTask({ prompt: "b" });
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("闸门快照", () => {
  it("create 与 query 是两个独立的窗口，建任务不会拖慢查询", () => {
    markVideoCall("create");
    const snap = videoGateSnapshot();

    expect(snap.create.minIntervalMs).toBe(60_000);
    expect(snap.create.retryAfterMs).toBeGreaterThan(0);
    /* 查询窗口不受影响 —— 这正是本次修的 bug */
    expect(snap.query.minIntervalMs).toBe(4_000);
    expect(snap.query.retryAfterMs).toBe(0);
  });
});

describe("VideoError", () => {
  it("保留 code / status / detail / retryAfterMs", () => {
    const e = new VideoError("UPSTREAM", "m", "d", 429, 1000);
    expect(e.code).toBe("UPSTREAM");
    expect(e.status).toBe(429);
    expect(e.detail).toBe("d");
    expect(e.retryAfterMs).toBe(1000);
    expect(e).toBeInstanceOf(Error);
  });
});
