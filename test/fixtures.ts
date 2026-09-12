import type { Outline, Shot, Storyboard, StyleSpec } from "@/lib/schema";
import { OutlineSchema, StoryboardSchema, StyleSpecSchema } from "@/lib/schema";

/** 测试用风格规格（含 1 个关键词，便于断言 verbatim 注入） */
export function makeStyle(): StyleSpec {
  return StyleSpecSchema.parse({
    name_zh: "极简高级风",
    name_en: "Minimal Premium",
    seed_match: "minimal",
    rationale: "产品需要克制留白",
    style: "极简、克制、留白",
    color: "单色背景 + 正红点缀",
    lighting: "柔和顶光",
    composition: "居中对称",
    materials: "磨砂玻璃与金属",
    motion: "缓慢旋转",
    camera: "固定机位",
    palette: ["#0E0E10", "#C8102E"],
    keywords_en: ["clean ivory background", "soft studio light"],
    negative: "clutter, text",
  });
}

/** 测试用分镜（3 镜，含节拍与状态链） */
export function makeStoryboard(): Storyboard {
  return StoryboardSchema.parse({
    meta: { title: "口红广告", aspect_ratio: "9:16", target_duration: 5, shots_count: 2 },
    shots: [
      {
        index: 1,
        start: 0,
        duration: 2.5,
        shot_type: "特写",
        camera_movement: "缓慢环绕",
        scene: "纯色影棚背景",
        subject: "正红色丝绒口红",
        action: "口红缓缓旋转",
        voiceover: "",
        audio: "低沉的弦乐铺底",
        transition_out: "匹配剪辑：旋转动势接下一镜转头",
        start_state: "口红直立，切面朝向镜头",
        end_state: "口红旋转至切面朝右 45°",
        image_prompt: "A red lipstick standing upright, clean ivory background",
        video_prompt: "A red lipstick slowly rotating, soft studio light, a 2.5-second shot",
        beats: ["0-1s: begins slow rotation", "1-2.5s: settles at 45°"],
        beats_cn: ["0-1s：开始缓慢旋转", "1-2.5s：停在 45°"],
        negative_prompt: "blur",
        image_prompt_cn: "一支红色口红直立",
        video_prompt_cn: "口红缓缓旋转",
        negative_prompt_cn: "模糊",
      },
      {
        index: 2,
        start: 2.5,
        duration: 2.5,
        shot_type: "近景",
        camera_movement: "固定",
        scene: "纯色影棚背景",
        subject: "模特唇部",
        action: "模特涂抹口红后回眸",
        voiceover: "一抹正红，气场全开",
        audio: "节拍落点",
        transition_out: "—",
        start_state: "口红旋转至切面朝右 45°",
        end_state: "模特正面直视镜头，唇色饱满",
        image_prompt: "A model with red lips looking at camera",
        video_prompt: "The model applies lipstick then turns back, a 2.5-second shot",
        beats: ["0-2.5s: applies and turns back"],
        beats_cn: ["0-2.5s：涂抹后回眸"],
        negative_prompt: "clutter",
        image_prompt_cn: "模特红唇直视镜头",
        video_prompt_cn: "模特涂抹口红后回眸",
        negative_prompt_cn: "杂乱",
      },
    ],
    global_negative: "watermark, logo",
    consistency_notes: ["口红为正红色丝绒哑光"],
  });
}

/** 测试用大纲（含实体档案与状态链） */
export function makeOutline(): Outline {
  return OutlineSchema.parse({
    meta: { title: "口红广告", aspect_ratio: "9:16", target_duration: 5 },
    shots_count: 2,
    global_negative: "watermark, logo",
    consistency_notes: ["口红为正红色丝绒哑光"],
    entities: [{ name_zh: "口红", descriptor_en: "velvet matte true-red lipstick, bullet face toward camera" }],
    outline: [
      {
        index: 1,
        duration: 2.5,
        shot_type: "特写",
        scene: "纯色影棚背景",
        action: "口红缓缓旋转",
        voiceover: "",
        start_state: "口红直立，切面朝向镜头",
        end_state: "口红旋转至切面朝右 45°",
        transition_out: "匹配剪辑：旋转动势接下一镜转头",
      },
      {
        index: 2,
        duration: 2.5,
        shot_type: "近景",
        scene: "纯色影棚背景",
        action: "模特涂抹口红后回眸",
        voiceover: "一抹正红",
        start_state: "口红旋转至切面朝右 45°",
        end_state: "模特正面直视镜头",
        transition_out: "—",
      },
    ],
  });
}

/** 事件用的空 Shot 数组（neighbors 参数） */
export const noNeighbors: Shot[] = [];
