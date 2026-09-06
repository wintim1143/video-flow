"use client";

import { useState } from "react";
import type { Shot } from "@/lib/schema";
import { formatTimecode } from "@/lib/schema";
import { CopyButton } from "./CopyButton";
import { EditableText } from "./EditableText";

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
}: {
  label: string;
  en: string;
  cn: string;
  accent: string;
  lang: Lang;
  onEn: (v: string) => void;
  onCn: (v: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium" style={{ color: accent }}>
          {label}
        </span>
        <CopyButton text={lang === "en" ? en : cn || en} label="复制" />
      </div>
      {lang === "en" ? (
        <EditableText value={en} onCommit={onEn} mono placeholder={label} />
      ) : (
        <EditableText value={cn} onCommit={onCn} placeholder={`${label}（中文对照）`} />
      )}
    </div>
  );
}

export function ShotRow({
  shot,
  globalNegative,
  globalNegativeCn,
  onShot,
}: {
  shot: Shot;
  globalNegative: string;
  globalNegativeCn?: string;
  onShot: (next: Shot) => void;
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
        </div>
      </div>
    </div>
  );
}
