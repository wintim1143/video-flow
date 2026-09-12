"use client";

import { useState } from "react";
import type { Shot } from "@/lib/schema";
import { formatTimecode } from "@/lib/schema";
import type { CreateVideoPayload, VideoTaskUi } from "@/lib/use-video-tasks";
import { CopyButton } from "./CopyButton";
import { EditableText } from "./EditableText";
import { KeyframeBar } from "./KeyframeBar";
import { VideoGenBar } from "./VideoGenBar";

type Lang = "en" | "cn";

function MetaLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-[13px] leading-relaxed">
      <span className="w-11 shrink-0 text-[var(--muted)]">{label}</span>
      <span className="flex-1">{value}</span>
    </div>
  );
}

/** 编辑某个 shot 指定字段 */
function patchField(
  shot: Shot,
  field: keyof Shot,
  value: string,
  onShot: (next: Shot) => void
) {
  onShot({ ...shot, [field]: value });
}

/** 编辑某个 shot 的字符串数组字段（beats / beats_cn） */
function patchList(
  shot: Shot,
  field: "beats" | "beats_cn",
  next: string[],
  onShot: (nextShot: Shot) => void
) {
  onShot({ ...shot, [field]: next });
}

/** 中文提示词切换按钮组 */
function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[var(--border)]">
      {(["en", "cn"] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`px-2 py-0.5 text-[11px] transition-colors ${
            lang === l ? "bg-[var(--accent)] text-[#041016]" : "text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          {l === "en" ? "EN" : "中文"}
        </button>
      ))}
    </div>
  );
}

/** 双语可编辑 Prompt 块 */
function BilingualPrompt({
  label,
  en,
  cn,
  accent,
  lang,
  onEn,
  onCn,
  copyPrefix,
}: {
  label: string;
  en: string;
  cn: string;
  accent: string;
  lang: Lang;
  onEn: (v: string) => void;
  onCn: (v: string) => void;
  /** 复制时附加的前置说明（画幅/时长/类型，投喂豆包等平台时免得再确认） */
  copyPrefix?: string;
}) {
  const copyText = (base: string) => (copyPrefix ? `${copyPrefix}\n${base}` : base);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium" style={{ color: accent }}>
          {label}
        </span>
        <CopyButton text={copyText(lang === "en" ? en : cn || en)} label="复制" />
      </div>
      {lang === "en" ? (
        <EditableText value={en} onCommit={onEn} mono placeholder={label} />
      ) : (
        <EditableText value={cn} onCommit={onCn} placeholder={`${label}（中文对照）`} />
      )}
    </div>
  );
}

/** 秒级节拍编辑块（beats：按时段拆分的连续小动作，节奏控制核心） */
function BeatsBlock({
  beats,
  beatsCn,
  lang,
  onBeats,
  onBeatsCn,
}: {
  beats: string[];
  beatsCn: string[];
  lang: Lang;
  onBeats: (next: string[]) => void;
  onBeatsCn: (next: string[]) => void;
}) {
  const list = lang === "en" ? beats : beatsCn.length ? beatsCn : beats;
  if (!list.length) return null;
  const update = (i: number, v: string) => {
    const next = [...list];
    next[i] = v;
    if (lang === "en") onBeats(next);
    else onBeatsCn(next);
  };
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium" style={{ color: "var(--accent-2)" }}>
          秒级节拍 · Beats
        </span>
        <CopyButton text={list.join("\n")} label="复制" />
      </div>
      <div className="space-y-1">
        {list.map((b, i) => (
          <EditableText key={i} value={b} onCommit={(v) => update(i, v)} mono placeholder={`节拍 ${i + 1}`} />
        ))}
      </div>
    </div>
  );
}

export function ShotRow({
  shot,
  aspectRatio,
  globalNegative,
  globalNegativeCn,
  onShot,
  videoEnabled = false,
  videoTask,
  videoBusy = false,
  videoCreateReadyAt = 0,
  keyframeEnabled = false,
  keyframeBusy = false,
  keyframeError,
  onCreateVideo,
  onRemoveVideo,
  onRefreshVideo,
  onGenerateKeyframe,
  onClearKeyframe,
}: {
  shot: Shot;
  /** 画幅（来自分镜 meta），复制视频 prompt 时作为前置说明 */
  aspectRatio?: string;
  globalNegative: string;
  globalNegativeCn?: string;
  onShot: (next: Shot) => void;
  /** 是否已配置视频 LLM；未配置时本行不出现生成入口 */
  videoEnabled?: boolean;
  /** 本镜的视频任务状态（由页面级的单一轮询器驱动） */
  videoTask?: VideoTaskUi;
  videoBusy?: boolean;
  /** 生成配额的全局冷却结束时间戳（账户级，所有分镜共用同一个冷却） */
  videoCreateReadyAt?: number;
  /** 是否已配置图片 LLM（闸门 2 关键帧的开关） */
  keyframeEnabled?: boolean;
  keyframeBusy?: boolean;
  keyframeError?: string;
  onCreateVideo?: (payload: CreateVideoPayload) => void;
  onRemoveVideo?: () => void;
  onRefreshVideo?: () => void;
  onGenerateKeyframe?: (prompt: string) => void;
  onClearKeyframe?: () => void;
}) {
  const [lang, setLang] = useState<Lang>("en");
  const negEn = [globalNegative, shot.negative_prompt].filter(Boolean).join(", ");
  const negCn = [globalNegativeCn, shot.negative_prompt_cn].filter(Boolean).join(", ");

  return (
    <div id={`shot-${shot.index}`} className="panel scroll-mt-4 overflow-hidden">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5">
        <span className="mono text-[13px] font-semibold" style={{ color: "var(--accent)" }}>
          #{shot.index}
        </span>
        <span className="mono text-[12px] text-[var(--muted)]">
          {formatTimecode(shot.start)} → {formatTimecode(shot.start + shot.duration)}
        </span>
        <span className="chip mono">{shot.duration}s</span>
        {shot.shot_type ? <span className="chip">{shot.shot_type}</span> : null}
        {shot.camera_movement ? <span className="chip">{shot.camera_movement}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="chip text-[11px]">转场 · {shot.transition_out || "—"}</span>
          <LangToggle lang={lang} setLang={setLang} />
        </span>
      </div>

      {/* 状态链：镜首 ← 上一镜末状态承接 → 镜末（连续性的核心可视信息） */}
      {shot.start_state || shot.end_state ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-[11.5px] leading-relaxed">
          <span style={{ color: "var(--accent-2)" }}>状态链</span>
          {shot.start_state ? <span className="chip whitespace-normal text-left">镜首 {shot.start_state}</span> : null}
          <span className="text-[var(--muted)]">→</span>
          {shot.end_state ? <span className="chip whitespace-normal text-left">镜末 {shot.end_state}</span> : null}
        </div>
      ) : null}

      <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* 左栏：中文分镜卡（可编辑文案字段） */}
        <div className="space-y-1.5">
          <MetaLine label="场景" value={shot.scene} />
          <MetaLine label="主体" value={shot.subject} />
          <MetaLine label="动作" value={shot.action} />
          <MetaLine label="口播" value={shot.voiceover} />
          <MetaLine label="音频" value={shot.audio} />
        </div>

        {/* 右栏：双语可编辑 prompt */}
        <div>
          <BilingualPrompt
            label="Image Prompt · 首帧生图"
            en={shot.image_prompt}
            cn={shot.image_prompt_cn}
            accent="var(--accent-2)"
            lang={lang}
            onEn={(v) => patchField(shot, "image_prompt", v, onShot)}
            onCn={(v) => patchField(shot, "image_prompt_cn", v, onShot)}
          />
          <BilingualPrompt
            label="Video Prompt · 图生视频"
            en={shot.video_prompt}
            cn={shot.video_prompt_cn}
            accent="var(--accent)"
            lang={lang}
            onEn={(v) => patchField(shot, "video_prompt", v, onShot)}
            onCn={(v) => patchField(shot, "video_prompt_cn", v, onShot)}
            copyPrefix={
              lang === "en"
                ? `【广告视频 · 画幅 ${aspectRatio || "9:16"} · 本镜时长 ${shot.duration}秒 · 单镜独立生成】`
                : undefined
            }
          />
          <BeatsBlock
            beats={shot.beats ?? []}
            beatsCn={shot.beats_cn ?? []}
            lang={lang}
            onBeats={(next) => patchList(shot, "beats", next, onShot)}
            onBeatsCn={(next) => patchList(shot, "beats_cn", next, onShot)}
          />
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] text-[var(--muted)]">Negative Prompt</span>
              <CopyButton text={lang === "en" ? negEn : negCn || negEn} label="复制" />
            </div>
            {lang === "en" ? (
              <EditableText
                value={negEn}
                onCommit={(v) => patchField(shot, "negative_prompt", v, onShot)}
                mono
                placeholder="negative prompt"
              />
            ) : (
              <EditableText
                value={negCn}
                onCommit={(v) => patchField(shot, "negative_prompt_cn", v, onShot)}
                placeholder="负面词（中文对照）"
              />
            )}
          </div>
          <KeyframeBar
            shot={shot}
            aspectRatio={aspectRatio}
            enabled={keyframeEnabled}
            busy={keyframeBusy}
            error={keyframeError}
            onGenerate={(prompt) => onGenerateKeyframe?.(prompt)}
            onClear={() => onClearKeyframe?.()}
          />
          <VideoGenBar
            shot={shot}
            aspectRatio={aspectRatio}
            globalNegative={globalNegative}
            task={videoTask}
            enabled={videoEnabled}
            disabled={videoBusy}
            createReadyAt={videoCreateReadyAt}
            onCreate={(payload) => onCreateVideo?.(payload)}
            onRemove={() => onRemoveVideo?.()}
            onRefresh={() => onRefreshVideo?.()}
          />
        </div>
      </div>
    </div>
  );
}
