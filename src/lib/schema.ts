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
  /** 时间轴起点（秒）。逐镜展开时由服务端按大纲累加计算，LLM 不输出此字段（catch 兜底防 NaN） */
  start: z.coerce.number().catch(0),
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
  /**
   * 英文 · 秒级节拍：把本镜动作按时段拆分（如 "0-1s: ..."，末拍可短），首拍从 start_state 出发、
   * 末拍结束于 end_state。投喂生视频模型时帮助控制节奏，防止所有动作挤在一段粗粒度描述里。
   */
  beats: z.array(z.string()).catch([]),
  /** 中文 · beats 对照译文（用于展示/人工校准，不投喂生成） */
  beats_cn: z.array(z.string()).catch([]),
  /** 英文 · 本镜负面词 */
  negative_prompt: z.string().catch(""),
  /** 中文 · image_prompt 对照译文（用于展示/人工校准，不投喂生成） */
  image_prompt_cn: z.string().catch(""),
  /** 中文 · video_prompt 对照译文（用于展示/人工校准，不投喂生成） */
  video_prompt_cn: z.string().catch(""),
  /** 中文 · 本镜负面词对照译文（用于展示/人工校准） */
  negative_prompt_cn: z.string().catch(""),
  /** 中文 · 镜首状态（主体朝向/位置/状态 + 环境），来自大纲，展开时硬性沿用 */
  start_state: z.string().catch(""),
  /** 中文 · 镜末状态（该镜结束时主体与环境的定格状态），镜 N+1 的 start_state 必须承接此状态 */
  end_state: z.string().catch(""),
  /**
   * 闸门 2 产物：本镜关键帧图的**公网可达 URL**（由 `image_prompt` 生成）。
   *
   * 有值即作为 I2V 的 `first_frame`（适配器自动推断成 keyframe 模式），
   * 为空则退化为纯文生视频。必须是 URL 而非 base64 —— 上游要能自己把这张图拉下来。
   */
  keyframe_url: z.string().catch(""),
  /** 生成本关键帧时**实际使用**的 prompt（`image_prompt` 事后可能被编辑，留档便于对比重生成） */
  keyframe_prompt_used: z.string().catch(""),
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

/**
 * 分镜大纲（两段式第一步的产物）：每镜一句话规划，输出体量小、生成快。
 * start 由服务端按 duration 累加计算，不让 LLM 算（减少算术错误）。
 */
export const ShotOutlineItemSchema = z.object({
  index: z.coerce.number().int().min(1),
  duration: z.coerce.number().positive().catch(5),
  shot_type: z.string().catch(""),
  scene: z.string().catch(""),
  action: z.string().catch(""),
  voiceover: z.string().catch(""),
  /** 中文 · 镜首状态：主体朝向/位置/状态 + 环境（时间/天气/光源方向）。镜 N+1 必须承接镜 N 的 end_state */
  start_state: z.string().catch(""),
  /** 中文 · 镜末状态：该镜结束时主体与环境的定格状态 */
  end_state: z.string().catch(""),
  /** 中文 · 本镜到下一镜的转场方式与衔接画面（同场景=匹配剪辑/首尾帧衔接；换场=硬切/叠化等）。展开时照抄，不让 LLM 自由发挥 */
  transition_out: z.string().catch(""),
});
export type ShotOutlineItem = z.infer<typeof ShotOutlineItemSchema>;

/** 跨镜主体实体档案：descriptor_en 是锁定英文视觉描述符，逐镜 verbatim 拼进 prompt */
export const EntitySchema = z.object({
  name_zh: z.string().catch(""),
  /** 锁定英文描述（外观/朝向约定/关键状态词），逐镜不得改写 */
  descriptor_en: z.string().catch(""),
});
export type Entity = z.infer<typeof EntitySchema>;

export const OutlineSchema = z.object({
  meta: z
    .object({
      title: z.string().catch(""),
      aspect_ratio: z.string().catch("9:16"),
      target_duration: z.coerce.number().catch(30),
    })
    .catch({ title: "", aspect_ratio: "9:16", target_duration: 30 }),
  shots_count: z.coerce.number().catch(0),
  /** 全片统一负面词（英文），大纲阶段一次产出 */
  global_negative: z.string().catch(""),
  /** 跨镜一致性锁定项，大纲阶段一次产出、逐镜沿用 */
  consistency_notes: z.array(z.string()).catch([]),
  /** 实体档案：跨镜主体的锁定英文描述符（含朝向约定），大纲阶段一次产出 */
  entities: z.array(EntitySchema).catch([]),
  outline: z.array(ShotOutlineItemSchema).min(1),
});
export type Outline = z.infer<typeof OutlineSchema>;

export const StyleRequestSchema = z.object({
  /** 文字需求；纯图片提取风格时可为空（brief 与 image 至少一项，route 层校验） */
  brief: z.string().default(""),
  aspectRatio: z.string().default("9:16"),
  targetDuration: z.coerce.number().int().min(5).max(180).default(5),
  /** 使用哪个文本 LLM profile（llm.config.json text 组的 id）；缺省取第一个 */
  profileId: z.string().optional(),
  /**
   * 可选：参考图（data URL，客户端已压缩到 ≤1024px JPEG）。
   * 有图时走「图片提取风格」路径——brief 可为空串（此时图是唯一输入）。
   */
  imageDataUrl: z
    .string()
    .max(4_500_000, "图片过大（压缩后仍超 4.5MB）")
    .refine((v) => v.startsWith("data:image/") || v.startsWith("http"), "图片格式不合法")
    .optional(),
});
export type StyleRequest = z.infer<typeof StyleRequestSchema>;

export const ShotsRequestSchema = StyleRequestSchema.extend({
  style: StyleSpecSchema,
  /** 期望镜数；不传则由时长自动推算 */
  shotCount: z.coerce.number().int().min(1).max(24).optional(),
});
export type ShotsRequest = z.infer<typeof ShotsRequestSchema>;

/** 单镜重生成请求（/api/shot，SSE 分镜失败后的定点重试） */
export const SingleShotRequestSchema = StyleRequestSchema.extend({
  style: StyleSpecSchema,
  outline: OutlineSchema,
  /** 要重生成的镜头序号（取 outline 中对应项展开） */
  index: z.coerce.number().int().min(1),
  /** 已有相邻镜头（用于衔接一致性；可传空数组） */
  neighbors: z.array(ShotSchema).default([]),
});
export type SingleShotRequest = z.infer<typeof SingleShotRequestSchema>;

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
