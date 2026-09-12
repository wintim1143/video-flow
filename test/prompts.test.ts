import { describe, expect, it } from "vitest";
import {
  outlineSystemPrompt,
  outlineUserPrompt,
  shotDetailSystemPrompt,
  shotDetailUserPrompt,
  styleFromImageSystemPrompt,
  styleFromImageUserPrompt,
  styleSystemPrompt,
  suggestShotCount,
} from "@/lib/prompts";
import { makeOutline, makeStoryboard, makeStyle } from "./fixtures";

describe("suggestShotCount（按时长推算镜数）", () => {
  it("下限 2 镜、上限 24 镜", () => {
    expect(suggestShotCount(5)).toBe(2);
    expect(suggestShotCount(1)).toBe(2);
    expect(suggestShotCount(60)).toBe(12);
    expect(suggestShotCount(600)).toBe(24);
  });
});

describe("风格 prompt", () => {
  it("system prompt 含 seed 锚定说明与 JSON 字段约束", () => {
    const p = styleSystemPrompt();
    expect(p).toContain("keywords_en");
    expect(p).toContain("seed_match");
    expect(p).toContain("只输出纯 JSON 对象");
  });

  it("图片提取风格的 system prompt 要求从图中实际取色", () => {
    const p = styleFromImageSystemPrompt();
    expect(p).toContain("参考图");
    expect(p).toContain("必须从图中实际取色");
  });

  it("图片提取的 user prompt：brief 为空时不带文字补充段", () => {
    expect(styleFromImageUserPrompt({ brief: "  " })).not.toContain("文字补充");
    expect(styleFromImageUserPrompt({ brief: "口红广告" })).toContain("口红广告");
  });
});

describe("大纲 prompt（连续性硬规则）", () => {
  const p = outlineSystemPrompt();

  it("包含状态链连续性、主体贯穿、转场衔接三条最高优先级规则", () => {
    expect(p).toContain("状态链连续性（最高优先级）");
    expect(p).toContain("主体贯穿（最高优先级）");
    expect(p).toContain("转场衔接规划（最高优先级）");
  });

  it("要求同场景用匹配剪辑、禁止生硬跳切", () => {
    expect(p).toContain("匹配剪辑");
    expect(p).toContain("禁止无设计的生硬跳切");
  });

  it("要求输出 entities / transition_out / start_state / end_state", () => {
    for (const f of ["entities", "transition_out", "start_state", "end_state"]) {
      expect(p).toContain(f);
    }
  });

  it("user prompt 带上 brief / 画幅 / 时长 / 镜数", () => {
    const u = outlineUserPrompt({ brief: "口红广告", aspectRatio: "9:16", targetDuration: 5, shotCount: 2 });
    expect(u).toContain("口红广告");
    expect(u).toContain("9:16");
    expect(u).toContain("目标总时长：5 秒");
    expect(u).toContain("分镜数量：2 个");
  });
});

describe("单镜展开 prompt", () => {
  const style = makeStyle();
  const outline = makeOutline();
  const storyboard = makeStoryboard();

  it("system prompt 含节拍自适应粒度规则（不固定每秒一拍）", () => {
    const p = shotDetailSystemPrompt();
    expect(p).toContain("粒度由本镜动作复杂度决定");
    expect(p).toContain("0.5 秒级");
    expect(p).toContain("首拍必须从 start_state 出发");
  });

  it("system prompt 要求 video_prompt 写明确时长数值", () => {
    expect(shotDetailSystemPrompt()).toContain("明确的时长数值");
  });

  it("user prompt 注入上一镜末状态 / 本镜首末状态 / 转场设计", () => {
    const u2 = shotDetailUserPrompt({
      brief: "口红广告",
      style,
      outline,
      index: 2,
      neighbors: storyboard.shots,
    });
    expect(u2).toContain("上一镜（镜1）末状态");
    expect(u2).toContain("口红旋转至切面朝右 45°");
    expect(u2).toContain("本镜转场设计");

    // 镜1 的转场设计必须原样带入（匹配剪辑），末镜则是 "—"
    const u1 = shotDetailUserPrompt({ brief: "口红广告", style, outline, index: 1, neighbors: [] });
    expect(u1).toContain("匹配剪辑：旋转动势接下一镜转头");
    expect(u2).toContain("本镜转场设计】照抄到 transition_out 字段");
  });

  it("user prompt 注入实体档案 descriptor_en（verbatim 锚点）", () => {
    const u = shotDetailUserPrompt({ brief: "x", style, outline, index: 1, neighbors: [] });
    expect(u).toContain("velvet matte true-red lipstick, bullet face toward camera");
    expect(u).toContain("实体档案");
  });

  it("inline 的 style JSON 只带必要字段，不塞 palette 之外的噪音", () => {
    const u = shotDetailUserPrompt({ brief: "x", style, outline, index: 1, neighbors: [] });
    expect(u).toContain("keywords_en");
    expect(u).toContain("clean ivory background");
  });

  it("末镜在下一镜要点缺失时给出 CTA 提示", () => {
    const u = shotDetailUserPrompt({ brief: "x", style, outline, index: 2, neighbors: [] });
    expect(u).toContain("这是最后一个镜头");
  });
});

describe("死代码清理", () => {
  it("旧的单次大 JSON 分镜 prompt 已移除（两段式改造遗留）", async () => {
    const mod = (await import("@/lib/prompts")) as Record<string, unknown>;
    expect(mod.shotsSystemPrompt).toBeUndefined();
    expect(mod.shotsUserPrompt).toBeUndefined();
  });
});
