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
          `#${s.index} [${formatTimecode(s.start)}-${formatTimecode(s.start + s.duration)}] 本镜 ${s.duration}s\n${s.video_prompt}${s.beats?.length ? `\nSecond-by-second beats: ${s.beats.join(" | ")}` : ""}\nNegative: ${[globalNegative, s.negative_prompt].filter(Boolean).join(", ")}`
      )
      .join("\n\n")
  );
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
  lines.push(`- 转场：${s.transition_out}`, "");
  lines.push(`**Image Prompt · 首帧生图（EN）**`, "```", s.image_prompt, "```");
  if (s.image_prompt_cn) lines.push(`**Image Prompt 中文对照**`, "```", s.image_prompt_cn, "```");
  lines.push(`**Video Prompt · 图生视频（EN）**`, "```", s.video_prompt, "```");
  if (s.video_prompt_cn)   lines.push(`**Video Prompt 中文对照**`, "```", s.video_prompt_cn, "```");
  if (s.beats?.length) {
    lines.push(`**秒级节拍（EN）**`, "```", ...s.beats, "```");
    if (s.beats_cn?.length) lines.push(`**秒级节拍 中文对照**`, "```", ...s.beats_cn, "```");
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
