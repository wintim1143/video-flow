import { describe, expect, it } from "vitest";
import {
  OutlineSchema,
  ShotSchema,
  StoryboardSchema,
  StyleRequestSchema,
  StyleSpecSchema,
  formatTimecode,
} from "@/lib/schema";

const validStyle = {
  name_zh: "极简高级",
  name_en: "Minimal",
  seed_match: "minimal",
  rationale: "产品需要克制",
  style: "极简",
  color: "单色",
  lighting: "柔光",
  composition: "居中",
  materials: "磨砂玻璃",
  motion: "缓慢",
  camera: "固定",
  palette: ["#111111"],
  keywords_en: ["clean ivory background"],
  negative: "clutter",
};

describe("StyleRequestSchema", () => {
  it("空对象时 targetDuration 默认为 5（P0 回归防护：与前端 DEFAULT_DURATION 一致）", () => {
    const r = StyleRequestSchema.parse({});
    expect(r.targetDuration).toBe(5);
    expect(r.aspectRatio).toBe("9:16");
    expect(r.brief).toBe("");
  });

  it("targetDuration 支持字符串数字并拒绝越界值", () => {
    expect(StyleRequestSchema.parse({ targetDuration: "30" }).targetDuration).toBe(30);
    expect(StyleRequestSchema.safeParse({ targetDuration: 4 }).success).toBe(false);
    expect(StyleRequestSchema.safeParse({ targetDuration: 999 }).success).toBe(false);
  });

  it("imageDataUrl 校验：合法 data URL / http 通过，其它拒绝", () => {
    expect(StyleRequestSchema.safeParse({ imageDataUrl: "data:image/jpeg;base64,AAA" }).success).toBe(true);
    expect(StyleRequestSchema.safeParse({ imageDataUrl: "https://x/y.jpg" }).success).toBe(true);
    expect(StyleRequestSchema.safeParse({ imageDataUrl: "ftp://x/y.jpg" }).success).toBe(false);
    // refine 之后仍能校验长度上限
    expect(
      StyleRequestSchema.safeParse({ imageDataUrl: `data:image/jpeg;base64,${"A".repeat(4_500_001)}` }).success
    ).toBe(false);
  });
});

describe("ShotSchema 容错", () => {
  it("缺字段时用 catch 兜底，不抛错", () => {
    const s = ShotSchema.parse({ index: 1, duration: 3 });
    expect(s.shot_type).toBe("");
    expect(s.beats).toEqual([]);
    expect(s.beats_cn).toEqual([]);
    expect(s.start_state).toBe("");
    expect(s.end_state).toBe("");
    expect(s.start).toBe(0);
  });

  it("字符串数字被 coerce", () => {
    const s = ShotSchema.parse({ index: "2", duration: "3.5" });
    expect(s.index).toBe(2);
    expect(s.duration).toBe(3.5);
  });

  it("beats 非数组时兜底为空数组（旧数据兼容）", () => {
    const s = ShotSchema.parse({ index: 1, duration: 5, beats: null });
    expect(s.beats).toEqual([]);
  });
});

describe("OutlineSchema", () => {
  it("outline 至少 1 条，缺失则报错", () => {
    expect(OutlineSchema.safeParse({ outline: [] }).success).toBe(false);
  });

  it("补齐 entities / transition_out / 状态链的默认值", () => {
    const o = OutlineSchema.parse({ outline: [{ index: 1, duration: 5 }] });
    expect(o.entities).toEqual([]);
    expect(o.consistency_notes).toEqual([]);
    expect(o.global_negative).toBe("");
    expect(o.outline[0].transition_out).toBe("");
    expect(o.outline[0].start_state).toBe("");
    expect(o.outline[0].end_state).toBe("");
  });
});

describe("StoryboardSchema / formatTimecode", () => {
  it("meta 缺失时整体兜底", () => {
    const s = StoryboardSchema.parse({ shots: [{ index: 1, duration: 5 }] });
    expect(s.meta.aspect_ratio).toBe("9:16");
    expect(s.meta.shots_count).toBe(0);
  });

  it("StyleSpecSchema 对空对象全兜底", () => {
    const st = StyleSpecSchema.parse({});
    expect(st.palette).toEqual([]);
    expect(st.keywords_en).toEqual([]);
    expect(st.seed_match).toBeNull();
  });

  it("formatTimecode 输出 MM:SS.s", () => {
    expect(formatTimecode(0)).toBe("00:00.0");
    expect(formatTimecode(2.5)).toBe("00:02.5");
    expect(formatTimecode(65.5)).toBe("01:05.5");
    expect(formatTimecode(-3)).toBe("00:00.0");
  });

  it("validStyle 能被 StyleSpecSchema 接受（fixture 自检）", () => {
    expect(StyleSpecSchema.parse(validStyle).name_zh).toBe("极简高级");
  });
});
