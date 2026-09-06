"use client";

/**
 * 生成进度弹窗：全屏遮罩挡住页面交互，防止 SSE 生成期间误触其他操作。
 * - style / outline 阶段无确定性进度 → 不定长动画条
 * - shots 阶段 → done/total 进度条 + 实时 trace 消息
 * - onCancel 可选：中断生成（AbortController）
 */
export function ProgressModal({
  open,
  kind,
  done,
  total,
  message,
  onCancel,
}: {
  open: boolean;
  kind: "" | "style" | "outline" | "shots";
  done: number;
  total: number;
  message: string;
  onCancel?: () => void;
}) {
  if (!open) return null;

  const title =
    kind === "style"
      ? "正在匹配风格…"
      : kind === "outline"
        ? "正在生成分镜大纲…"
        : kind === "shots"
          ? "正在逐镜生成分镜…"
          : "生成中…";

  const indeterminate = kind !== "shots";
  const pct = indeterminate ? 0 : total ? Math.min(100, (done / total) * 100) : 0;

  return (
    <div
      className="vf-fadein fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(6, 9, 14, 0.72)", backdropFilter: "blur(3px)" }}
      /* 遮罩层吃掉所有点击，防止误触底下的按钮/tab */
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="panel mx-6 w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span
            className="vf-spin inline-block h-5 w-5 shrink-0 rounded-full"
            style={{ border: "2.5px solid var(--border)", borderTopColor: "var(--accent)" }}
          />
          <div>
            <div className="text-[14.5px] font-semibold">{title}</div>
            <div className="text-[11.5px] text-[var(--muted)]">
              生成期间页面已锁定，请勿进行其他操作
            </div>
          </div>
          {indeterminate ? (
            <span className="mono ml-auto text-[12px] text-[var(--muted)]">—</span>
          ) : (
            <span className="mono ml-auto text-[13px]" style={{ color: "var(--accent)" }}>
              {done}/{total} 镜
            </span>
          )}
        </div>

        {/* 进度条：分镜阶段按完成数；风格/大纲阶段不定长流动 */}
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]">
          {indeterminate ? (
            <div
              className="vf-indet h-full w-1/3 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          ) : (
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: "var(--accent)" }}
            />
          )}
        </div>

        {/* 实时 trace 消息 */}
        <div className="mt-3 min-h-[18px] text-[12.5px] leading-relaxed text-[var(--muted)]">
          {message || "…"}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
          <span className="text-[11px] text-[var(--muted)]">
            {kind === "shots" ? "完成一镜显示一镜，失败可单独重试" : "预计 10-60 秒，取决于模型速度"}
          </span>
          {onCancel ? (
            <button type="button" className="btn" onClick={onCancel}>
              取消生成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
