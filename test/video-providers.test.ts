import { describe, expect, it } from "vitest";
import type { LlmProfile } from "@/lib/llm-configs";
import {
  agnesProvider,
  openaiCompatProvider,
  resolveVideoProvider,
} from "@/lib/video-providers";
import { VideoError, normalizeStatus, originOf } from "@/lib/video-types";

const agnes = (over: Partial<LlmProfile> = {}): LlmProfile => ({
  id: "v1",
  name: "Agnes Video 2.5 Flash",
  baseURL: "https://api.agnes-ai.cn/v1",
  apiKey: "k",
  model: "agnes-video-2.5-flash",
  ...over,
});

describe("agnes · buildCreate", () => {
  it("text 模式：基础字段 + seconds 必须是字符串 + size 档位", () => {
    const { url, body } = agnesProvider.buildCreate(agnes(), {
      prompt: "雨后的未来城市街道",
      seconds: 5,
      aspectRatio: "16:9",
    });
    expect(url).toBe("https://api.agnes-ai.cn/v1/videos");
    expect(body).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "雨后的未来城市街道",
      mode: "text",
      seconds: "5", // 文档：字符串 "4"–"12"，不是 number
      size: "720P", // 文档：档位，不是 1280x720
      aspect_ratio: "16:9",
    });
  });

  it("未传时长时不带 seconds（交给上游用默认值）", () => {
    const { body } = agnesProvider.buildCreate(agnes(), { prompt: "x" });
    expect("seconds" in body).toBe(false);
  });

  it("时长超范围：本地就拦掉，不浪费一次配额去换 400", () => {
    expect(() => agnesProvider.buildCreate(agnes(), { prompt: "x", seconds: 3 })).toThrowError(VideoError);
    expect(() => agnesProvider.buildCreate(agnes(), { prompt: "x", seconds: 13 })).toThrowError(VideoError);
    try {
      agnesProvider.buildCreate(agnes(), { prompt: "x", seconds: 3 });
    } catch (e) {
      expect((e as VideoError).code).toBe("BAD_REQUEST");
    }
  });

  it("keyframe：用 first_frame / last_frame，且不能混入 images", () => {
    const { body } = agnesProvider.buildCreate(agnes(), {
      prompt: "转身走向窗边",
      firstFrame: "https://x/a.png",
      lastFrame: "https://x/b.png",
      images: ["https://x/ignored.png"],
    });
    expect(body.mode).toBe("keyframe");
    expect(body.first_frame).toBe("https://x/a.png");
    expect(body.last_frame).toBe("https://x/b.png");
    expect("images" in body).toBe(false);
  });

  it("keyframe 但没给帧 → 本地报错", () => {
    expect(() => agnesProvider.buildCreate(agnes(), { prompt: "x", mode: "keyframe" })).toThrowError(VideoError);
  });

  it("reference：images / audios 进请求体，不携带 first_frame（文档：reference 不许 first_frame）", () => {
    const { body } = agnesProvider.buildCreate(agnes(), {
      prompt: "以 <Picture 1> 为参考",
      mode: "reference",
      images: ["https://x/1.png"],
      audios: ["https://x/a.mp3"],
      firstFrame: "https://x/ignored.png",
    });
    expect(body.mode).toBe("reference");
    expect(body.images).toEqual(["https://x/1.png"]);
    expect(body.audios).toEqual(["https://x/a.mp3"]);
    expect("first_frame" in body).toBe(false);
  });

  it("同时给首帧和参考图且未指定 mode：keyframe 优先（帧控制比参考更强）", () => {
    const { body } = agnesProvider.buildCreate(agnes(), {
      prompt: "x",
      firstFrame: "https://x/1.png",
      images: ["https://x/2.png"],
    });
    expect(body.mode).toBe("keyframe");
    expect("images" in body).toBe(false);
  });

  it("reference 但没有任何参考媒体 → 本地报错", () => {
    expect(() => agnesProvider.buildCreate(agnes(), { prompt: "x", mode: "reference" })).toThrowError(VideoError);
  });

  it("extra 透传，但不能篡改 model / prompt / mode / seconds / size", () => {
    const { body } = agnesProvider.buildCreate(agnes(), {
      prompt: "x",
      seconds: 6,
      extra: {
        model: "hack",
        prompt: "hack",
        mode: "reference",
        seconds: "99",
        size: "4K",
        seed: 1101,
      },
    });
    expect(body.model).toBe("agnes-video-2.5-flash");
    expect(body.prompt).toBe("x");
    expect(body.mode).toBe("text");
    expect(body.seconds).toBe("6");
    expect(body.size).toBe("720P");
    expect(body.seed).toBe(1101); // 非保留字段照常透传
  });

  it("extra 里的 undefined 被忽略", () => {
    const { body } = agnesProvider.buildCreate(agnes(), {
      prompt: "x",
      extra: { seed: undefined, n: 1 },
    });
    expect("seed" in body).toBe(false);
    expect(body.n).toBe(1);
  });

  it("profile.mode 可强制覆盖推断结果", () => {
    const { body } = agnesProvider.buildCreate(agnes({ mode: "reference" }), {
      prompt: "x",
      images: ["https://x/1.png"],
    });
    expect(body.mode).toBe("reference");
  });
});

describe("agnes · inferMode（文档「生成模式规则」表）", () => {
  it("无媒体 → text", () => {
    expect(agnesProvider.inferMode({ prompt: "x" })).toBe("text");
  });
  it("有首帧或尾帧 → keyframe", () => {
    expect(agnesProvider.inferMode({ prompt: "x", firstFrame: "u" })).toBe("keyframe");
    expect(agnesProvider.inferMode({ prompt: "x", lastFrame: "u" })).toBe("keyframe");
  });
  it("有参考图或音频 → reference", () => {
    expect(agnesProvider.inferMode({ prompt: "x", images: ["u"] })).toBe("reference");
    expect(agnesProvider.inferMode({ prompt: "x", audios: ["u"] })).toBe("reference");
  });
});

describe("agnes · parseCreate", () => {
  it("取 video_id 作为轮询 ID（不是 id / task_id）", () => {
    const r = agnesProvider.parseCreate({
      id: "task_1",
      task_id: "task_1",
      video_id: "video_1",
      status: "queued",
      progress: 0,
    });
    expect(r.taskId).toBe("video_1");
    expect(r.upstreamId).toBe("task_1");
    expect(r.status).toBe("queued");
    expect(r.progress).toBe(0);
  });

  it("没有 video_id 时回退到 id（不返回空，让上层决定是否报错）", () => {
    expect(agnesProvider.parseCreate({ id: "task_1" }).taskId).toBe("task_1");
    expect(agnesProvider.parseCreate({}).taskId).toBeUndefined();
  });
});

describe("agnes · buildQuery", () => {
  it("跳出 /v1 命名空间，走 /agnesapi + query string，且带 model_name", () => {
    const url = agnesProvider.buildQuery(agnes(), "video_1");
    expect(url).toBe(
      "https://api.agnes-ai.cn/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash"
    );
    expect(url).not.toContain("/v1");
  });

  it("id 里的特殊字符被转义", () => {
    const url = agnesProvider.buildQuery(agnes(), "a b&c");
    expect(url).toContain("video_id=a+b%26c");
  });
});

describe("agnes · parseQuery", () => {
  it("completed → 取 metadata.url", () => {
    const r = agnesProvider.parseQuery({
      status: "completed",
      progress: 100,
      metadata: { url: "https://x/v.mp4" },
    });
    expect(r.status).toBe("completed");
    expect(r.videoUrl).toBe("https://x/v.mp4");
    expect(r.error).toBeUndefined();
  });

  it("completed 但只有顶层 url（apihub.agnes-ai.com 实测形态，无 metadata 字段）", () => {
    /* 这段是 2026-09-12 从 apihub.agnes-ai.com 抓到的真实响应，原样保留 */
    const real = {
      completed_at: 1789200557,
      created_at: 1789200520,
      error: null,
      expires_at: null,
      id: "task_IWkuD7yHRuBkUFr8VQhOjeFi83TnzN2u",
      internal_progress: 0,
      internal_status: "pending",
      object: "video",
      progress: 100,
      quality: "standard",
      remixed_from_video_id: null,
      seconds: "5",
      size: "720P",
      started_at: 1789200521,
      status: "completed",
      url: "https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_x.mp4",
    };
    const r = agnesProvider.parseQuery(real);
    expect(r.status).toBe("completed");
    expect(r.videoUrl).toBe("https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_x.mp4");
  });

  it("completed 但两个位置都没有 url → 不给一个假的地址", () => {
    expect(agnesProvider.parseQuery({ status: "completed" }).videoUrl).toBeUndefined();
  });

  it("未完成时不给 videoUrl（metadata.url 在 completed 前不可信）", () => {
    const r = agnesProvider.parseQuery({
      status: "in_progress",
      progress: 40,
      metadata: { url: "https://x/stale.mp4" },
    });
    expect(r.status).toBe("running");
    expect(r.videoUrl).toBeUndefined();
    expect(r.progress).toBe(40);
  });

  it("failed → 取 error.message", () => {
    const r = agnesProvider.parseQuery({
      status: "failed",
      metadata: null,
      error: { message: "Invalid reference media" },
    });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Invalid reference media");
  });

  it("failed 但没给 message 时也有兜底文案", () => {
    expect(agnesProvider.parseQuery({ status: "failed" }).error).toBeTruthy();
  });
});

describe("openaiCompat 兜底适配器", () => {
  const p = agnes({ baseURL: "https://api.openai.com/v1", model: "sora-2" });

  it("不发送 mode（该形态没有 mode 概念）", () => {
    const { body } = openaiCompatProvider.buildCreate(p, { prompt: "x", seconds: 5 });
    expect("mode" in body).toBe(false);
    expect(body.seconds).toBe("5");
  });

  it("首帧走 input_reference（与 Agnes 的 first_frame 不同名）", () => {
    const { body } = openaiCompatProvider.buildCreate(p, { prompt: "x", firstFrame: "https://x/a.png" });
    expect(body.input_reference).toBe("https://x/a.png");
  });

  it("查询走 path 参数而不是 query string", () => {
    expect(openaiCompatProvider.buildQuery(p, "vid_1")).toBe("https://api.openai.com/v1/videos/vid_1");
  });

  it("成片地址兼容 metadata.url 与 data[0].url", () => {
    expect(openaiCompatProvider.parseQuery({ status: "completed", metadata: { url: "a" } }).videoUrl).toBe("a");
    expect(openaiCompatProvider.parseQuery({ status: "completed", data: [{ url: "b" }] }).videoUrl).toBe("b");
  });
});

describe("resolveVideoProvider", () => {
  it("profile.provider 显式指定优先", () => {
    expect(resolveVideoProvider({ baseURL: "https://api.openai.com/v1", provider: "openai" }).id).toBe("openai");
  });

  it("未指定时按 baseURL 猜：含 agnes 走 agnes", () => {
    expect(resolveVideoProvider({ baseURL: "https://api.agnes-ai.cn/v1" }).id).toBe("agnes");
    expect(resolveVideoProvider({ baseURL: "https://apihub.agnes-ai.com/v1" }).id).toBe("agnes");
  });

  it("其它一律走通用兜底", () => {
    expect(resolveVideoProvider({ baseURL: "https://api.openai.com/v1" }).id).toBe("openai");
  });

  it("provider 写错时给出可选值清单", () => {
    try {
      resolveVideoProvider({ baseURL: "https://x/v1", provider: "kling" });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as VideoError;
      expect(err.code).toBe("UNKNOWN_PROVIDER");
      expect(err.message).toContain("agnes");
    }
  });
});

describe("工具函数", () => {
  it("normalizeStatus 归一化各厂商状态词", () => {
    expect(normalizeStatus("queued")).toBe("queued");
    expect(normalizeStatus("PENDING")).toBe("queued");
    expect(normalizeStatus("in_progress")).toBe("running");
    expect(normalizeStatus("succeeded")).toBe("completed");
    expect(normalizeStatus("failed")).toBe("failed");
    expect(normalizeStatus("whatever")).toBe("unknown");
    expect(normalizeStatus(undefined)).toBe("unknown");
  });

  it("originOf 从 /v1 基址取回 origin", () => {
    expect(originOf("https://api.agnes-ai.cn/v1")).toBe("https://api.agnes-ai.cn");
  });
});
