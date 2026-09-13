"use client";

import { useEffect, useState } from "react";
import type { Shot } from "@/lib/schema";
import { shotVideoPrompt } from "@/lib/exports";
import { buildShotVideoPayload } from "@/lib/video-payload";
import type { CreateVideoPayload, VideoTaskUi } from "@/lib/use-video-tasks";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  unknown: "状态未知",
};

const STATUS_COLOR: Record<string, string> = {
  queued: "var(--muted)",
  running: "var(--accent-2)",
  completed: "var(--accent)",
  failed: "var(--err)",
  unknown: "var(--muted)",
};

function secs(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/** 已等待时长：60s 内显示「45s」，超过显示「2分05秒」 */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

/**
 * 单镜视频生成条。
 *
 * 异步任务形态：点「生成视频」→ 服务端建任务返回 taskId → hook 里的全局定时器轮询。
 * 两条时间线互不相干：**生成**吃配额要等（全局冷却，所有分镜一起倒计时），
 * **查询**不限流（1–2 秒一次即可出进度）。
 */
export function VideoGenBar({
  shot,
  aspectRatio,
  globalNegative,
  task,
  enabled,
  disabled,
  createReadyAt,
  prevEndKeyframeUrl,
  onCreate,
  onRemove,
  onRefresh,
}: {
  shot: Shot;
  aspectRatio?: string;
  globalNegative: string;
  task?: VideoTaskUi;
  /** 是否已配置视频 LLM（未配置时整条不渲染，由页面统一给配置指引） */
  enabled: boolean;
  disabled?: boolean;
  /** 生成配额的全局冷却结束时间戳（账户级，所有分镜共用） */
  createReadyAt?: number;
  /** 上一镜的收尾帧 URL（S3 共享端点帧）：存在时优先于本镜首帧作 first_frame */
  prevEndKeyframeUrl?: string;
  onCreate: (payload: CreateVideoPayload) => void;
  onRemove: () => void;
  onRefresh: () => void;
}) {
  /* 倒计时需要每秒重绘；生成冷却结束且任务终态后停掉，避免无意义的定时器 */
  const [, tick] = useState(0);
  const settled = !task || task.status === "completed" || task.status === "failed";
  const cooling = (createReadyAt ?? 0) > Date.now();
  useEffect(() => {
    if (settled && !cooling) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [settled, cooling, task?.nextPollAt]);

  if (!enabled) return null;

  const pending = task && !settled;
  const coolMs = Math.max(0, (createReadyAt ?? 0) - Date.now());

  return (
    <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium" style={{ color: "var(--accent)" }}>
          视频生成
        </span>
        <span
          className="chip mono text-[11px]"
          style={{
            color: shot.keyframe_url || prevEndKeyframeUrl ? "var(--accent)" : "var(--muted)",
          }}
          title={
            prevEndKeyframeUrl
              ? "首帧 = 上一镜收尾帧（共享端点帧，接缝连续）；尾帧 = 本镜收尾帧（若有）"
              : shot.keyframe_url
                ? "已带本镜关键帧首帧，走图生视频（keyframe 模式）"
                : "未生成任何关键帧，将走纯文生视频；建议先在闸门 2 出图"
          }
        >
          {prevEndKeyframeUrl
            ? "I2V · 首帧=上一镜尾帧"
            : shot.keyframe_url
              ? "I2V · 首帧=本镜关键帧"
              : "文生视频 · 无首帧"}
          {shot.end_keyframe_url ? " · 尾帧已锚" : ""}
        </span>
        {task ? (
          <span className="chip mono text-[11px]" style={{ color: STATUS_COLOR[task.status] }}>
            {STATUS_LABEL[task.status] ?? task.status}
            {typeof task.progress === "number" && pending ? ` ${task.progress}%` : ""}
            {task.provider ? ` · ${task.provider}` : ""}
            {task.mode ? ` · ${task.mode}` : ""}
          </span>
        ) : null}
        {task && pending ? (
          <span className="text-[11px] text-[var(--muted)]">已等待 {fmtElapsed(Date.now() - task.createdAt)}</span>
        ) : null}
        {coolMs > 0 ? (
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>
            生成配额冷却 {secs(coolMs)}s（全账户共用，每分钟 1 次）
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          {pending ? (
            <button type="button" className="btn" onClick={onRefresh} title="查询不限流，可随时刷新">
              立即查询
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || coolMs > 0 || !shot.video_prompt?.trim()}
            title={coolMs > 0 ? `生成配额冷却中，约 ${secs(coolMs)}s 后可再次生成` : undefined}
            onClick={() => onCreate(buildShotVideoPayload(shot, aspectRatio, globalNegative, prevEndKeyframeUrl))}
          >
            {coolMs > 0 ? `冷却 ${secs(coolMs)}s` : task ? "重新生成" : "生成视频"}
          </button>
          {task ? (
            <button type="button" className="btn" onClick={onRemove} title="仅清除本镜的任务记录，不删上游任务">
              清除
            </button>
          ) : null}
        </span>
      </div>

      {/* 进行中：进度条 + 人话状态。排队和生成都可能持续几分钟，必须让用户确信「在跑」 */}
      {task && pending ? (
        <div className="mt-2.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
            {typeof task.progress === "number" && task.status === "running" ? (
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.min(100, Math.max(3, task.progress))}%`, background: "var(--accent-2)" }}
              />
            ) : (
              <div className="vf-indet h-full w-1/4 rounded-full" style={{ background: "var(--accent-2)" }} />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
            <span>
              {task.status === "queued"
                ? "已建任务 · 上游排队中（免费档高峰通常要等 1–3 分钟）"
                : `模型生成中${typeof task.progress === "number" ? ` · ${task.progress}%` : "…"}`}
            </span>
            <span>可离开本页，任务进度已本地保存</span>
          </div>
        </div>
      ) : null}

      {task?.taskId ? (
        <div className="mt-1.5 text-[11px] text-[var(--muted)]">
          taskId <code className="mono">{task.taskId}</code>
        </div>
      ) : null}

      {task?.error ? (
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--err)" }}>
          {task.error}
        </div>
      ) : null}

      {task?.status === "completed" && task.videoUrl ? (
        <div className="mt-3">
          <video
            src={task.videoUrl}
            controls
            className="max-h-[360px] w-auto rounded-md border border-[var(--border)]"
          />
          <div className="mt-2 flex items-center gap-2">
            <a className="btn" href={task.videoUrl} target="_blank" rel="noreferrer">
              打开原片
            </a>
            <a className="btn" href={task.videoUrl} download={`shot-${shot.index}.mp4`}>
              下载 .mp4
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
