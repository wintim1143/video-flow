import type { Shot, Storyboard, StyleSpec } from "./schema";
import { formatTimecode } from "./schema";

export function bundleAll(storyboard: Storyboard, style: StyleSpec) {
  return JSON.stringify({ style, storyboard }, null, 2);
}

export function allImagePrompts(storyboard: Storyboard): string {
  return storyboard.shots
    .map((s) => `#${s.index} [${formatTimecode(s.start)}-${formatTimecode(s.start + s.duration)}]\n${s.image_prompt}`)
    .join("\n\n");
}

export function allVideoPrompts(storyboard: Storyboard, globalNegative: string): string {
  const total = storyboard.shots.reduce((acc, s) => acc + s.duration, 0);
  const head = `【广告视频 · 画幅 ${storyboard.meta.aspect_ratio || "9:16"} · 总时长约 ${Math.round(total)}秒 · 共 ${storyboard.shots.length} 镜 · 按镜序串行生成，每镜末帧作为下一镜首帧参考】\n\n`;
  return (
    head +
    storyboard.shots
      .map(
        (s) =>
          `#${s.index} [${formatTimecode(s.start)}-${formatTimecode(s.start + s.duration)}] 本镜 ${s.duration}s\n${s.video_prompt}${s.beats?.length ? `\nBeats: ${s.beats.join(" | ")}` : ""}\nNegative: ${[globalNegative, s.negative_prompt].filter(Boolean).join(", ")}`
      )
      .join("\n\n")
  );
}

/**
 * 单镜视频 prompt：真正投喂视频模型的那一条 ——
 * 运动描述 + 节拍时间轴 + 状态链 + 负面词。
 * 与 allVideoPrompts（批量导出给人看）和 wholeVideoPrompt（整片单 prompt）互补。
 */
export function shotVideoPrompt(s: Shot, globalNegative: string): string {
  const neg = [globalNegative, s.negative_prompt].filter(Boolean).join(", ");
  const parts = [s.video_prompt.trim()];
  if (s.beats?.length) parts.push(`Beats: ${s.beats.join(" | ")}`);
  if (s.start_state || s.end_state) {
    parts.push(`State: ${[s.start_state, s.end_state].filter(Boolean).join(" → ")}`);
  }
  if (neg) parts.push(`Avoid: ${neg}`);
  return parts.filter(Boolean).join("\n");
}

function shotMd(s: Shot, globalNegative: string): string {
  const lines = [
    `### Shot ${s.index} · ${formatTimecode(s.start)} → ${formatTimecode(s.start + s.duration)} · ${s.duration}s · ${s.shot_type} · ${s.camera_movement}`,
    "",
    `- 场景：${s.scene}`,
    `- 主体：${s.subject}`,
    `- 动作：${s.action}`,
  ];
  if (s.voiceover) lines.push(`- 口播/字幕：${s.voiceover}`);
  if (s.audio) lines.push(`- 音频：${s.audio}`);
  if (s.start_state || s.end_state) {
    lines.push(`- 状态链：${s.start_state || "—"} → ${s.end_state || "—"}`);
  }
  lines.push(`- 转场：${s.transition_out}`, "");
  lines.push(`**Image Prompt · 首帧生图（EN）**`, "```", s.image_prompt, "```");
  if (s.image_prompt_cn) lines.push(`**Image Prompt 中文对照**`, "```", s.image_prompt_cn, "```");
  lines.push(`**Video Prompt · 图生视频（EN）**`, "```", s.video_prompt, "```");
  if (s.video_prompt_cn)   lines.push(`**Video Prompt 中文对照**`, "```", s.video_prompt_cn, "```");
  if (s.beats?.length) {
    lines.push(`**节拍（EN）**`, "```", ...s.beats, "```");
    if (s.beats_cn?.length) lines.push(`**节拍 中文对照**`, "```", ...s.beats_cn, "```");
  }
  lines.push(
    `**Negative（EN）**`,
    "```",
    [globalNegative, s.negative_prompt].filter(Boolean).join(", "),
    "```",
    ""
  );
  if (s.negative_prompt_cn) {
    lines.push(`**Negative 中文对照**`, "```", s.negative_prompt_cn, "```", "");
  }
  return lines.join("\n");
}

export function toMarkdown(storyboard: Storyboard, style: StyleSpec): string {
  const m = storyboard.meta;
  const total = storyboard.shots.reduce((acc, s) => acc + s.duration, 0);
  const head = [
    `# ${m.title || "广告分镜脚本"}`,
    "",
    `> 类型：广告（Commercial）｜ 风格：${style.name_zh}${style.name_en ? `（${style.name_en}）` : ""} ｜ 画幅 ${m.aspect_ratio} ｜ 目标 ${m.target_duration}s / 实际 ${total.toFixed(1)}s ｜ ${storyboard.shots.length} 镜`,
    "",
    "## 风格规格",
    "",
    `**${style.name_zh}**${style.seed_match ? ` · 命中内置风格 \`${style.seed_match}\`` : " · 自由定义"}`,
    "",
    style.rationale ? `> ${style.rationale}` : "",
    "",
    `| 维度 | 设定 |`,
    `|---|---|`,
    `| 风格 | ${style.style} |`,
    `| 色彩 | ${style.color} |`,
    `| 光照 | ${style.lighting} |`,
    `| 构图 | ${style.composition} |`,
    `| 材质 | ${style.materials} |`,
    `| 运动 | ${style.motion} |`,
    `| 镜头 | ${style.camera} |`,
    "",
    `色板：${style.palette.join(" · ")}`,
    "",
    `英文关键词（逐镜 verbatim 复用）：${style.keywords_en.join(", ")}`,
    "",
    `统一负面词：${storyboard.global_negative}`,
    "",
  ];
  if (storyboard.consistency_notes.length) {
    head.push("## 跨镜一致性锁定", "", ...storyboard.consistency_notes.map((n) => `- ${n}`), "");
  }
  head.push("## 分镜", "");
  head.push(
    "> **尾帧链工作流**：按镜序串行生成视频 → 每镜生成后截取最后一帧 → 下一镜用该帧作为首帧生图参考（图生视频），两镜动势即可无缝衔接；换场镜按各镜标注的转场方式拼接。",
    ""
  );
  return [
    ...head,
    ...storyboard.shots.map((s) => shotMd(s, storyboard.global_negative)),
  ].join("\n");
}

/**
 * 整片单 prompt：按「整片模式」视频模型（Seedance / MiniMax h3 / 即梦长视频）的惯用结构，
 * 把整条分镜拼成**一条**可直接投喂的长 prompt —— 全局头 → 主体角色卡 → 转场前后状态 →
 * 逐镜（含节拍时间轴）→ 声音设计 → 约束清单。与逐镜模式互补，不改动逐镜工作流。
 */
export function wholeVideoPrompt(
  storyboard: Storyboard,
  style: StyleSpec,
  opts?: {
    /** 大纲产出的实体档案（锁定主体外观描述）；Storyboard 本身不存此字段，由页面传入 */
    entities?: Array<{ name_zh: string; descriptor_en: string }>;
    /** 片型，默认「广告片（Commercial）」 */
    type?: string;
  }
): string {
  const m = storyboard.meta;
  const shots = storyboard.shots;
  const total = shots.reduce((acc, s) => acc + s.duration, 0);
  const voices = shots.map((s) => s.voiceover).filter(Boolean);
  const lines: string[] = [];

  /* ── 全局头 ── */
  lines.push(
    `【类型】${opts?.type ?? "广告片（Commercial）"}`,
    `【时长】约 ${total.toFixed(1)} 秒`,
    `【画幅】${m.aspect_ratio}${m.aspect_ratio === "9:16" ? " 竖屏" : m.aspect_ratio === "16:9" ? " 横屏" : " 方形"}`,
    `【风格】${style.name_zh}${style.name_en ? `（${style.name_en}）` : ""}：${style.style}；色彩 ${style.color}；光照 ${style.lighting}；构图 ${style.composition}；材质 ${style.materials}；镜头 ${style.camera}`,
    `【视觉关键词】${style.keywords_en.join(", ")}`,
    `【色板】${style.palette.join(" · ")}`,
    `【语言】${voices.length ? "有口播，见各镜" : "无对白，无字幕"}`,
    ""
  );

  /* ── 主体角色卡 ── */
  lines.push("【主体角色卡】（跨镜必须保持完全一致，禁止换脸 / 换造型 / 变形）");
  if (opts?.entities?.length) {
    for (const e of opts.entities) lines.push(`- ${e.name_zh}：${e.descriptor_en}`);
  } else {
    lines.push("- （大纲未产出实体档案，请以各镜 prompt 中的主体描述为准）");
  }
  if (storyboard.consistency_notes.length) {
    for (const n of storyboard.consistency_notes) lines.push(`- 锁定项：${n}`);
  }
  lines.push("");

  /* ── 全片状态：首镜镜首 → 末镜镜末 ── */
  const first = shots[0];
  const last = shots[shots.length - 1];
  if (first?.start_state || last?.end_state) {
    lines.push("【全片状态弧】");
    if (first?.start_state) lines.push(`开场状态：${first.start_state}`);
    if (last?.end_state) lines.push(`收场状态：${last.end_state}`);
    lines.push("");
  }

  /* ── 逐镜（含节拍时间轴）── */
  lines.push("【镜头与时间轴】", "");
  for (const s of shots) {
    lines.push(
      `[${formatTimecode(s.start)}-${formatTimecode(s.start + s.duration)}] 镜头${s.index}｜${s.shot_type}｜${s.camera_movement}`
    );
    lines.push(`场景：${s.scene}`);
    if (s.subject) lines.push(`主体：${s.subject}`);
    if (s.action) lines.push(`动作：${s.action}`);
    if (s.start_state || s.end_state) {
      lines.push(`状态：${s.start_state || "—"} → ${s.end_state || "—"}`);
    }
    if (s.beats?.length) {
      lines.push("时间轴：");
      for (const b of s.beats) lines.push(`  ${b}`);
    }
    lines.push(`画面：${s.image_prompt}`);
    lines.push(`运动：${s.video_prompt}`);
    lines.push(`转场：${s.transition_out || "—"}`);
    lines.push("");
  }

  /* ── 声音设计 ── */
  const audios = shots.filter((s) => s.audio);
  if (audios.length) {
    lines.push("【声音设计】");
    for (const s of audios) lines.push(`- ${formatTimecode(s.start)} 镜头${s.index}：${s.audio}`);
    if (voices.length) {
      for (const s of shots.filter((x) => x.voiceover)) lines.push(`- 口播｜镜头${s.index}：${s.voiceover}`);
    }
    lines.push("");
  }

  /* ── 约束清单 ── */
  const negs = Array.from(
    new Set(
      [storyboard.global_negative, ...shots.map((s) => s.negative_prompt)]
        .join(",")
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean)
    )
  );
  if (negs.length) {
    lines.push("【主要约束】（负向清单，生成时禁止出现）");
    lines.push(negs.join(", "));
  }

  return lines.join("\n");
}
