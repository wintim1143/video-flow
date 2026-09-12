import { describe, expect, it } from "vitest";
import type { LlmProfile } from "@/lib/llm-configs";
import { VideoError, buildVideoBody } from "@/lib/video";

const profile = (over: Partial<LlmProfile> = {}): LlmProfile => ({
  id: "v1",
  name: "Agnes Video",
  baseURL: "https://apihub.agnes-ai.com/v1",
  apiKey: "k",
  model: "agnes-video-2.5-flash",
  ...over,
});

describe("buildVideoBody", () => {
  it("必填 model + prompt + mode（mode 取自配置）", () => {
    const body = buildVideoBody(profile({ mode: "text" }), { prompt: "一只苹果" });
    expect(body).toEqual({ model: "agnes-video-2.5-flash", prompt: "一只苹果", mode: "text" });
  });

  it("请求级 mode 覆盖配置值", () => {
    const body = buildVideoBody(profile({ mode: "text" }), { prompt: "x", mode: "image" });
    expect(body.mode).toBe("image");
  });

  it("缺 mode 时给出可操作的报错（不猜取值）", () => {
    expect(() => buildVideoBody(profile(), { prompt: "x" })).toThrowError(VideoError);
    try {
      buildVideoBody(profile(), { prompt: "x" });
    } catch (e) {
      const err = e as VideoError;
      expect(err.code).toBe("MODE_MISSING");
      expect(err.message).toContain("llm.config.json");
    }
  });

  it("有首帧图时带 image 字段", () => {
    const body = buildVideoBody(profile({ mode: "image" }), {
      prompt: "x",
      imageUrl: "data:image/jpeg;base64,AAA",
    });
    expect(body.image).toBe("data:image/jpeg;base64,AAA");
  });

  it("extra 原样透传（各平台 duration/resolution 命名不同）", () => {
    const body = buildVideoBody(profile({ mode: "text" }), {
      prompt: "x",
      extra: { duration: 5, resolution: "720p", seed: 0 },
    });
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe("720p");
    expect(body.seed).toBe(0); // 0 不能被当成空值丢掉
  });

  it("extra 不能篡改 model / prompt / mode", () => {
    const body = buildVideoBody(profile({ mode: "text" }), {
      prompt: "x",
      extra: { model: "hack", prompt: "hack", mode: "hack", aspect_ratio: "9:16" },
    });
    expect(body.model).toBe("agnes-video-2.5-flash");
    expect(body.prompt).toBe("x");
    expect(body.mode).toBe("text");
    expect(body.aspect_ratio).toBe("9:16");
  });

  it("extra 里的 undefined 被忽略", () => {
    const body = buildVideoBody(profile({ mode: "text" }), {
      prompt: "x",
      extra: { duration: undefined, resolution: "720p" },
    });
    expect("duration" in body).toBe(false);
    expect(body.resolution).toBe("720p");
  });
});

describe("VideoError", () => {
  it("保留 code / status / detail", () => {
    const e = new VideoError("UPSTREAM", "m", "d", 429);
    expect(e.code).toBe("UPSTREAM");
    expect(e.status).toBe(429);
    expect(e.detail).toBe("d");
    expect(e).toBeInstanceOf(Error);
  });
});
