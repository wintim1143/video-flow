import { describe, expect, it } from "vitest";
import { allImagePrompts, allVideoPrompts, bundleAll, shotVideoPrompt, toMarkdown, wholeVideoPrompt } from "@/lib/exports";
import { makeOutline, makeStoryboard, makeStyle } from "./fixtures";

const storyboard = makeStoryboard();
const style = makeStyle();

describe("shotVideoPrompt", () => {
  const s = storyboard.shots[0];

  it("拼出投喂视频模型的那一条：运动 + 节拍 + 状态链 + 负面词", () => {
    const out = shotVideoPrompt(s, storyboard.global_negative);
    expect(out.split("\n")[0]).toBe(s.video_prompt);
    expect(out).toContain("Beats: 0-1s: begins slow rotation | 1-2.5s: settles at 45°");
    expect(out).toContain("State: 口红直立，切面朝向镜头 → 口红旋转至切面朝右 45°");
    expect(out).toContain("Avoid: watermark, logo, blur");
  });

  it("没有节拍 / 状态链 / 负面词时就是纯粹的 video_prompt", () => {
    const out = shotVideoPrompt(
      { ...s, beats: [], start_state: "", end_state: "", negative_prompt: "" },
      ""
    );
    expect(out).toBe(s.video_prompt);
  });

  it("负面词叠加全局与本镜（去重前先拼接，保持顺序）", () => {
    const out = shotVideoPrompt({ ...s, negative_prompt: "" }, "watermark");
    expect(out).toContain("Avoid: watermark");
    expect(out).not.toContain("Avoid: watermark, ");
  });
});

describe("allVideoPrompts", () => {
  const out = allVideoPrompts(storyboard, storyboard.global_negative);

  it("带全局头：画幅 / 总时长 / 镜数 / 串行说明", () => {
    expect(out).toContain("【广告视频 · 画幅 9:16");
    expect(out).toContain("共 2 镜");
    expect(out).toContain("每镜末帧作为下一镜首帧参考");
  });

  it("每镜带时码、时长、节拍、负面词", () => {
    expect(out).toContain("#1 [00:00.0-00:02.5] 本镜 2.5s");
    expect(out).toContain("Beats: 0-1s: begins slow rotation | 1-2.5s: settles at 45°");
    expect(out).toContain("Negative: watermark, logo, blur");
  });

  it("不再使用旧的 Second-by-second 措辞（beats 已改为自适应粒度）", () => {
    expect(out).not.toContain("Second-by-second");
  });
});

describe("allImagePrompts", () => {
  it("逐镜输出 image_prompt 与时码", () => {
    const out = allImagePrompts(storyboard);
    expect(out).toContain("#1 [00:00.0-00:02.5]");
    expect(out).toContain("A red lipstick standing upright");
  });
});

describe("toMarkdown", () => {
  const md = toMarkdown(storyboard, style);

  it("头部含类型/风格/画幅/时长/镜数", () => {
    expect(md).toContain("类型：广告（Commercial）");
    expect(md).toContain("极简高级风");
    expect(md).toContain("9:16");
    expect(md).toContain("2 镜");
  });

  it("含尾帧链工作流说明与状态链", () => {
    expect(md).toContain("尾帧链工作流");
    expect(md).toContain("口红旋转至切面朝右 45°");
  });

  it("节拍块用「节拍」而非「秒级节拍」", () => {
    expect(md).toContain("**节拍（EN）**");
    expect(md).toContain("**节拍 中文对照**");
    expect(md).not.toContain("秒级节拍");
  });

  it("含跨镜一致性锁定与风格色板", () => {
    expect(md).toContain("跨镜一致性锁定");
    expect(md).toContain("#C8102E");
  });
});

describe("bundleAll", () => {
  it("是可解析的 JSON，含 style 与 storyboard", () => {
    const j = JSON.parse(bundleAll(storyboard, style));
    expect(j.style.name_zh).toBe("极简高级风");
    expect(j.storyboard.shots).toHaveLength(2);
  });
});

describe("wholeVideoPrompt（整片单 prompt 导出）", () => {
  const outline = makeOutline();
  const out = wholeVideoPrompt(storyboard, style, { entities: outline.entities });

  it("全局头含类型/时长/画幅/风格/视觉关键词/语言", () => {
    expect(out).toContain("【类型】广告片（Commercial）");
    expect(out).toContain("【时长】约 5.0 秒");
    expect(out).toContain("【画幅】9:16 竖屏");
    expect(out).toContain("【视觉关键词】clean ivory background, soft studio light");
    expect(out).toContain("【语言】有口播，见各镜");
  });

  it("含主体角色卡（实体档案 descriptor_en）与锁定项", () => {
    expect(out).toContain("【主体角色卡】");
    expect(out).toContain("velvet matte true-red lipstick, bullet face toward camera");
    expect(out).toContain("锁定项：口红为正红色丝绒哑光");
  });

  it("含全片状态弧（首镜镜首 → 末镜镜末）", () => {
    expect(out).toContain("【全片状态弧】");
    expect(out).toContain("开场状态：口红直立，切面朝向镜头");
    expect(out).toContain("收场状态：模特正面直视镜头，唇色饱满");
  });

  it("逐镜含时码、时间轴节拍、画面、运动、转场", () => {
    expect(out).toContain("【镜头与时间轴】");
    expect(out).toContain("[00:00.0-00:02.5] 镜头1｜特写｜缓慢环绕");
    expect(out).toContain("时间轴：");
    expect(out).toContain("  0-1s: begins slow rotation");
    expect(out).toContain("画面：A red lipstick standing upright");
    expect(out).toContain("转场：匹配剪辑：旋转动势接下一镜转头");
  });

  it("含声音设计与约束清单（负面词去重）", () => {
    expect(out).toContain("【声音设计】");
    expect(out).toContain("低沉的弦乐铺底");
    expect(out).toContain("口播｜镜头2：一抹正红，气场全开");
    expect(out).toContain("【主要约束】");
    expect(out).toContain("watermark");
  });

  it("无实体档案时给出降级说明而非报错", () => {
    const o = wholeVideoPrompt(storyboard, style);
    expect(o).toContain("大纲未产出实体档案");
  });

  it("可自定义片型", () => {
    const o = wholeVideoPrompt(storyboard, style, { type: "品牌宣传片（Brand Film）" });
    expect(o).toContain("【类型】品牌宣传片（Brand Film）");
  });
});
