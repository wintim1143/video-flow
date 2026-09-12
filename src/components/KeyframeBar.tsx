"use client";

import { useEffect, useState } from "react";
import type { Shot } from "@/lib/schema";
import { MAX_KEYFRAME_ATTEMPTS, keyframeSizeFor } from "@/lib/use-keyframes";
import { EditableText } from "./EditableText";

/**
 * 闸门 2 · 关键帧（单镜）。
 *
 * M1 的核心链路是「先生关键帧 → 再图生视频」，而不是一步文生视频：
 * 首帧锁死了主体的外观与构图，运动部分才交给视频模型，跨镜一致性才有锚点。
 *
 * 这里负责：用 `Shot.image_prompt`（可改）出一张图 → 存回 `Shot.keyframe_url`
 * → `buildPayload` 自动把它作为 `first_frame` 传给视频接口。
 */
export function KeyframeBar({
  shot,
  aspectRatio,
  enabled,
  busy,
  error,
  onGenerate,
  onClear,
}: {
  shot: Shot;
  aspectRatio?: string;
  /** 是否配置了图片 LLM；未配置时整块降级为配置指引 */
  enabled: boolean;
  busy: boolean;
  error?: string;
  onGenerate: (prompt: string) => void;
  onClear: () => void;
}) {
  const fallbackPrompt = shot.image_prompt || shot.video_prompt || "";
  const [prompt, setPrompt] = useState(fallbackPrompt);
  const [touched, setTouched] = useState(false);

  /* 分镜重生成 / 编辑后，未手改过 prompt 就跟着走 */
  useEffect(() => {
    if (!touched) setPrompt(fallbackPrompt);
  }, [fallbackPrompt, touched]);

  const settled = Boolean(shot.keyframe_url);
  const size = keyframeSizeFor(aspectRatio);

  /*
   * R3.2：闸门 2 的「确认/重出 ≤2 次」。
   * attempts 含首次，所以上限是 3（首次 + 2 次重出）。超了默认锁住按钮 ——
   * 解禁是**显式**的（点「解除限制」），不弹二次确认框：本地工具里反复打磨是正当需求，
   * 但默认状态必须守住判据，否则「闸门 2 人工把关防乱烧」就没有落点。
   * 解禁状态只活在本次会话（刷新即失效），符合「每次会话重新受约束」的意图。
   */
  const [unlocked, setUnlocked] = useState(false);
  /* SSE 流式回来的 shot 不带这个字段（服务端手工拼的对象），所以必须兜底 */
  const attempts = shot.keyframe_attempts ?? 0;
  const regens = Math.max(0, attempts - 1);
  const capped = attempts >= MAX_KEYFRAME_ATTEMPTS && !unlocked;

  return (
    <div
      className="mb-3 rounded-md border p-3"
      style={{
        borderColor: settled ? "var(--border)" : "var(--warn, var(--border))",
        background: "var(--panel-2)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium" style={{ color: settled ? "var(--accent)" : "var(--warn, var(--accent))" }}>
          闸门 2 · 关键帧
        </span>
        {settled ? (
          <span className="chip mono text-[11px]" style={{ color: "var(--accent)" }}>
            已就位 · 视频走 I2V
          </span>
        ) : (
          <span className="chip mono text-[11px] text-[var(--muted)]">未生成 · 视频将退化为文生视频</span>
        )}
        <span className="chip mono text-[11px] text-[var(--muted)]">{size}</span>
        {regens > 0 ? (
          <span className="chip mono text-[11px]" style={{ color: capped ? "var(--err)" : "var(--muted)" }}>
            已重出 {regens}/{MAX_KEYFRAME_ATTEMPTS - 1}
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !enabled || !prompt.trim() || capped}
            title={capped ? `已达重出上限（${MAX_KEYFRAME_ATTEMPTS - 1} 次）。确认要继续请点「解除限制」。` : undefined}
            onClick={() => onGenerate(prompt)}
          >
            {busy ? "生成中…" : settled ? "重新生成" : "生成关键帧"}
          </button>
          {capped ? (
            <button
              type="button"
              className="btn"
              onClick={() => setUnlocked(true)}
              title="超出 R3.2 判据（重出 ≤2 次）继续生成，会消耗图片配额"
            >
              解除限制
            </button>
          ) : null}
          {settled ? (
            <button type="button" className="btn" onClick={onClear} title="仅清除本镜首帧，视频会退回文生视频模式">
              清除
            </button>
          ) : null}
        </span>
      </div>

      {!enabled ? (
        <div className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
          未配置图片 LLM，无法生成关键帧。在 <code className="mono text-[var(--text)]">llm.config.json</code> 的{" "}
          <code className="mono text-[var(--text)]">image</code> 组补一条 profile 即可。
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--err)" }}>
          {error}
        </div>
      ) : null}

      {capped ? (
        <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--err)" }}>
          本镜已重出 {regens} 次，达到闸门 2 的上限（{MAX_KEYFRAME_ATTEMPTS - 1} 次）。确认还要继续就点「解除限制」；
          否则建议先改关键帧 prompt，或回风格 tab 调整方向 —— 反复重出同一描述通常是 prompt 本身的问题。
        </div>
      ) : null}

      {settled ? (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shot.keyframe_url}
            alt={`第 ${shot.index} 镜关键帧`}
            className="max-h-[280px] w-auto rounded-md border border-[var(--border)]"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <a className="btn" href={shot.keyframe_url} target="_blank" rel="noreferrer">
              打开原图
            </a>
            <a className="btn" href={shot.keyframe_url} download={`shot-${shot.index}-keyframe.png`}>
              下载
            </a>
            {shot.keyframe_prompt_used && shot.keyframe_prompt_used !== prompt ? (
              <span className="text-[11px] text-[var(--muted)]">当前 prompt 已改动，未重新生成</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {enabled ? (
        <details className="mt-2" open={!settled}>
          <summary className="cursor-pointer text-[11.5px] text-[var(--muted)]">
            关键帧 prompt（默认取本镜 image_prompt，可改）
          </summary>
          <div className="mt-2">
            <EditableText
              value={prompt}
              onCommit={(v) => {
                setTouched(true);
                setPrompt(v);
              }}
              mono
              rows={3}
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTouched(false);
                  setPrompt(fallbackPrompt);
                }}
              >
                按本镜 image_prompt 重置
              </button>
              {shot.keyframe_prompt_used ? (
                <span className="text-[11px] text-[var(--muted)]">
                  上次生成用的 prompt 已留档于 <code className="mono">keyframe_prompt_used</code>
                </span>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
