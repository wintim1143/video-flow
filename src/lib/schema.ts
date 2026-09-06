import { z } from "zod";

/**
 * 风格规格 —— 内化 awesome-gpt-image-2 的 schema 思维，不做运行时外部依赖（15 号决策 1）。
 * 图像五维（style / color / lighting / composition / materials）
 * 视频补三维（motion / camera / negative）
 */
export const StyleSpecSchema = z.object({
  name_zh: z.string().catch(""),
  name_en: z.string().catch(""),
  /** 命中的内置 seed 风格 id，纯自由发挥时为 null */
  seed_match: z.string().nullable().catch(null),
  /** 为什么选这套风格（一句话，给用户看） */
  rationale: z.string().catch(""),
  style: z.string().catch(""),
  color: z.string().catch(""),
  lighting: z.string().catch(""),
  composition: z.string().catch(""),
  materials: z.string().catch(""),
  motion: z.string().catch(""),
  camera: z.string().catch(""),
  /** 主色板 hex，用于 UI 色板与 prompt 取色 */
  palette: z.array(z.string()).catch([]),
  /** 英文风格关键词，逐镜 verbatim 拼进 prompt 保一致性 */
  keywords_en: z.array(z.string()).catch([]),
  /** 风格层负面词（英文） */
  negative: z.string().catch(""),
});
export type StyleSpec = z.infer<typeof StyleSpecSchema>;

/**
 * 单个分镜。左栏中文给人读，右栏英文 prompt 给模型吃。
 * 遵循 ai-cinematic 规则：一镜一动作、先锁首帧再谈运动。
 */
export const ShotSchema = z.object({
  index: z.coerce.number().int().min(1),
  start: z.coerce.number().min(0),
  duration: z.coerce.number().positive(),
  shot_type: z.string().catch(""),
  camera_movement: z.string().catch(""),
  scene: z.string().catch(""),
  subject: z.string().catch(""),
  action: z.string().catch(""),
  voiceover: z.string().catch(""),
  audio: z.string().catch(""),
  transition_out: z.string().catch(""),
  /** 英文 · 首帧生图 prompt（静态描述，不含运动）。用于生成，主版本 */
  image_prompt: z.string().catch(""),
  /** 英文 · 生视频 prompt（= 静态描述 + 镜头运动 + 动作 + 时长）。用于生成，主版本 */
  video_prompt: z.string().catch(""),
  /** 英文 · 本镜负面词 */
  negative_prompt: z.string().catch(""),
  /** 中文 · image_prompt 对照译文（用于展示/人工校准，不投喂生成） */
  image_prompt_cn: z.string().catch(""),
  /** 中文 · video_prompt 对照译文（用于展示/人工校准，不投喂生成） */
  video_prompt_cn: z.string().catch(""),
  /** 中文 · 本镜负面词对照译文（用于展示/人工校准） */
  negative_prompt_cn: z.string().catch(""),
});
export type Shot = z.infer<typeof ShotSchema>;

export const StoryboardSchema = z.object({
  meta: z
    .object({
      title: z.string().catch(""),
      aspect_ratio: z.string().catch("9:16"),
      target_duration: z.coerce.number().catch(30),
      shots_count: z.coerce.number().catch(0),
    })
    .catch({ title: "", aspect_ratio: "9:16", target_duration: 30, shots_count: 0 }),
  shots: z.array(ShotSchema).min(1),
  /** 全片统一负面词（英文），逐镜 negative_prompt 之上叠加 */
  global_negative: z.string().catch(""),
  /** 跨镜一致性锁定项（角色/产品/Logo 属性），逐镜必须 verbatim 复用 */
  consistency_notes: z.array(z.string()).catch([]),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const StyleRequestSchema = z.object({
  brief: z.string().min(1, "请输入广告描述"),
  aspectRatio: z.string().default("9:16"),
  targetDuration: z.coerce.number().int().min(5).max(180).default(30),
  /** 使用哪个文本 LLM profile（llm.config.json text 组的 id）；缺省取第一个 */
  profileId: z.string().optional(),
});
export type StyleRequest = z.infer<typeof StyleRequestSchema>;

export const ShotsRequestSchema = StyleRequestSchema.extend({
  style: StyleSpecSchema,
  /** 期望镜数；不传则由时长自动推算 */
  shotCount: z.coerce.number().int().min(1).max(24).optional(),
});
export type ShotsRequest = z.infer<typeof ShotsRequestSchema>;

export type AspectRatio = "9:16" | "16:9" | "1:1";

export const ASPECT_LABEL: Record<AspectRatio, string> = {
  "9:16": "竖屏 9:16 · 抖音/视频号",
  "16:9": "横屏 16:9 · B站/YouTube",
  "1:1": "方形 1:1 · 信息流",
};

export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.round(sec * 10) / 10);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${r}`;
}
