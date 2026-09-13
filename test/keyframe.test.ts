import { describe, expect, it } from "vitest";
import { ShotSchema, type Shot } from "@/lib/schema";
import { buildShotVideoPayload } from "@/lib/video-payload";
import { MAX_KEYFRAME_ATTEMPTS, endKeyframePrompt, keyframeSizeFor } from "@/lib/use-keyframes";
import { agnesProvider } from "@/lib/video-providers";

/**
 * M1 核心链路的回归防护：**关键帧是否真的作为首帧传到了视频接口**。
 *
 * 这条链路的断法很隐蔽 —— 适配器支持 keyframe、路由也收 firstFrame，
 * 只有「组装请求」这一步忘了带上，结果一路静默退化成纯文生视频，肉眼看不出来。
 */

const AGNES_PROFILE = {
  id: "v1",
  name: "Agnes Video 2.5 Flash",
  baseURL: "https://apihub.agnes-ai.com/v1",
  apiKey: "test-key",
  model: "agnes-video-2.5-flash",
  provider: "agnes",
};

function makeShot(over: Partial<Shot> = {}): Shot {
  return ShotSchema.parse({
    index: 1,
    duration: 5,
    video_prompt: "Slow push in on the red lipstick",
    image_prompt: "A matte red lipstick on white seamless backdrop",
    ...over,
  });
}

describe("keyframeSizeFor", () => {
  it("与视频画布严格同比例 —— keyframe 模式下成片画幅由首帧决定", () => {
    expect(keyframeSizeFor("9:16")).toBe("720x1280");
    expect(keyframeSizeFor("16:9")).toBe("1280x720");
    expect(keyframeSizeFor("1:1")).toBe("720x720");
    expect(keyframeSizeFor(undefined)).toBe("720x720");
  });
});

describe("buildShotVideoPayload：关键帧 → 首帧", () => {
  it("有关键帧 → 带上 firstFrame", () => {
    const p = buildShotVideoPayload(makeShot({ keyframe_url: "https://cdn.test/kf.png" }), "9:16", "");
    expect(p.firstFrame).toBe("https://cdn.test/kf.png");
    expect(p.aspectRatio).toBe("9:16");
    expect(p.seconds).toBe(5);
    expect(p.prompt).toContain("Slow push in");
  });

  it("无关键帧 → **不带** firstFrame（不能传空串，否则会触发 keyframe 模式的必填校验）", () => {
    const p = buildShotVideoPayload(makeShot(), "9:16", "");
    expect("firstFrame" in p).toBe(false);
  });

  it("首帧为空串等同没有", () => {
    const p = buildShotVideoPayload(makeShot({ keyframe_url: "" }), "9:16", "");
    expect("firstFrame" in p).toBe(false);
  });

  it("时长向上取整且不小于 1", () => {
    expect(buildShotVideoPayload(makeShot({ duration: 4.4 }), undefined, "").seconds).toBe(4);
    expect(buildShotVideoPayload(makeShot({ duration: 0.2 }), undefined, "").seconds).toBe(1);
  });

  it("画幅缺省回落到 9:16", () => {
    expect(buildShotVideoPayload(makeShot(), undefined, "").aspectRatio).toBe("9:16");
  });
});

describe("端到端接线：payload → agnes 适配器", () => {
  it("带关键帧的 payload 会让适配器产出 keyframe 模式 + first_frame 字段", () => {
    const payload = buildShotVideoPayload(makeShot({ keyframe_url: "https://cdn.test/kf.png" }), "9:16", "");
    const { body } = agnesProvider.buildCreate(AGNES_PROFILE, payload);

    expect(body.mode).toBe("keyframe");
    expect(body.first_frame).toBe("https://cdn.test/kf.png");
    /* keyframe 模式不允许带 reference 系的媒体字段 */
    expect("images" in body).toBe(false);
    expect("audios" in body).toBe(false);
  });

  it("没关键帧则仍是 text 模式，且不带任何首尾帧字段", () => {
    const payload = buildShotVideoPayload(makeShot(), "9:16", "");
    const { body } = agnesProvider.buildCreate(AGNES_PROFILE, payload);

    expect(body.mode).toBe("text");
    expect("first_frame" in body).toBe(false);
    expect("last_frame" in body).toBe(false);
  });
});

describe("Shot schema 的关键帧字段", () => {
  it("缺省填空串（模型输出里本来就没有这两个字段）", () => {
    const s = ShotSchema.parse({ index: 1, duration: 5 });
    expect(s.keyframe_url).toBe("");
    expect(s.keyframe_prompt_used).toBe("");
  });

  it("原样保留已生成的关键帧与留档 prompt", () => {
    const s = ShotSchema.parse({
      index: 2,
      duration: 5,
      keyframe_url: "https://cdn.test/a.png",
      keyframe_prompt_used: "a matte red lipstick",
    });
    expect(s.keyframe_url).toBe("https://cdn.test/a.png");
    expect(s.keyframe_prompt_used).toBe("a matte red lipstick");
  });

  it("坏值不炸（null / 数字都收敛成空串）", () => {
    const s = ShotSchema.parse({ index: 3, duration: 5, keyframe_url: null, keyframe_prompt_used: 123 });
    expect(s.keyframe_url).toBe("");
    expect(s.keyframe_prompt_used).toBe("");
  });
});

describe("R3.2 关键帧重出上限", () => {
  it("口径钉死：首次 + 2 次重出 = 3（改这个数就是改判据，必须是有意为之）", () => {
    expect(MAX_KEYFRAME_ATTEMPTS).toBe(3);
  });

  it("旧数据没有这个字段 → 解析为 0，而不是 NaN", () => {
    expect(ShotSchema.parse({ index: 1, duration: 5 }).keyframe_attempts).toBe(0);
  });

  it("坏值也收敛成 0", () => {
    expect(ShotSchema.parse({ index: 1, duration: 5, keyframe_attempts: "abc" }).keyframe_attempts).toBe(0);
    expect(ShotSchema.parse({ index: 1, duration: 5, keyframe_attempts: null }).keyframe_attempts).toBe(0);
  });

  it("计数原样保留", () => {
    expect(ShotSchema.parse({ index: 1, duration: 5, keyframe_attempts: 2 }).keyframe_attempts).toBe(2);
  });
});

describe("S3 共享端点帧：首尾帧优先级", () => {
  it("上一镜尾帧存在 → firstFrame 用它（接缝优先），本镜首帧被顶掉", () => {
    const p = buildShotVideoPayload(
      makeShot({ keyframe_url: "https://cdn.test/kf.png", end_keyframe_url: "https://cdn.test/end.png" }),
      "9:16",
      "",
      "https://cdn.test/prev-end.png"
    );
    expect(p.firstFrame).toBe("https://cdn.test/prev-end.png");
    expect(p.lastFrame).toBe("https://cdn.test/end.png");
  });

  it("无上一镜尾帧 → 退回本镜关键帧（S0 行为），lastFrame 照带", () => {
    const p = buildShotVideoPayload(
      makeShot({ keyframe_url: "https://cdn.test/kf.png", end_keyframe_url: "https://cdn.test/end.png" }),
      "9:16",
      ""
    );
    expect(p.firstFrame).toBe("https://cdn.test/kf.png");
    expect(p.lastFrame).toBe("https://cdn.test/end.png");
  });

  it("只有上一镜尾帧、本镜什么都没有 → firstFrame 仍成立（尾帧链可以独立于首帧工作）", () => {
    const p = buildShotVideoPayload(makeShot(), "9:16", "", "https://cdn.test/prev-end.png");
    expect(p.firstFrame).toBe("https://cdn.test/prev-end.png");
    expect("lastFrame" in p).toBe(false);
  });

  it("无尾帧 → 不带 lastFrame（空串等同没有）", () => {
    const p = buildShotVideoPayload(makeShot({ end_keyframe_url: "" }), "9:16", "");
    expect("lastFrame" in p).toBe(false);
  });

  it("端到端：上一镜尾帧 + 本镜尾帧 → agnes 产出首尾帧控制的 keyframe 模式", () => {
    const payload = buildShotVideoPayload(
      makeShot({ end_keyframe_url: "https://cdn.test/end.png" }),
      "9:16",
      "",
      "https://cdn.test/prev-end.png"
    );
    const { body } = agnesProvider.buildCreate(AGNES_PROFILE, payload);
    expect(body.mode).toBe("keyframe");
    expect(body.first_frame).toBe("https://cdn.test/prev-end.png");
    expect(body.last_frame).toBe("https://cdn.test/end.png");
  });
});

describe("endKeyframePrompt：尾帧 prompt 派生", () => {
  it("end_state 为核心 + image_prompt_cn 保持视觉语言", () => {
    const p = endKeyframePrompt(
      makeShot({ end_state: "刺客短刃被格挡，剑客收剑", image_prompt_cn: "雨夜竹林，冷峻写实水墨" })
    );
    expect(p).toContain("本镜收尾瞬间的定格画面：刺客短刃被格挡，剑客收剑");
    expect(p).toContain("雨夜竹林，冷峻写实水墨");
  });

  it("end_state 缺失 → 退回 video_prompt_cn", () => {
    const p = endKeyframePrompt(makeShot({ end_state: "", video_prompt_cn: "两人对撞" }));
    expect(p).toContain("两人对撞");
  });

  it("全部为空 → 空串（按钮会被 prompt 校验拦住）", () => {
    expect(endKeyframePrompt(makeShot({ end_state: "", video_prompt_cn: "", video_prompt: "", image_prompt_cn: "", image_prompt: "" }))).toBe("");
  });
});

describe("S3 schema 字段", () => {
  it("end_keyframe_url / end_keyframe_attempts 缺省收敛（旧 localStorage 数据兼容）", () => {
    const s = ShotSchema.parse({ index: 1, duration: 5 });
    expect(s.end_keyframe_url).toBe("");
    expect(s.end_keyframe_prompt_used).toBe("");
    expect(s.end_keyframe_attempts).toBe(0);
  });

  it("坏值不炸", () => {
    const s = ShotSchema.parse({ index: 1, duration: 5, end_keyframe_url: null, end_keyframe_attempts: "x" });
    expect(s.end_keyframe_url).toBe("");
    expect(s.end_keyframe_attempts).toBe(0);
  });
});
