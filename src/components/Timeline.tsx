"use client";

import type { Shot } from "@/lib/schema";
import { formatTimecode } from "@/lib/schema";

export function Timeline({
  shots,
  onPick,
}: {
  shots: Shot[];
  onPick: (index: number) => void;
}) {
  if (!shots.length) return null;
  const total = shots.reduce((a, s) => a + s.duration, 0) || 1;

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] text-[var(--muted)]">时间轴 · 点击定位</span>
        <span className="mono text-[12px] text-[var(--muted)]">
          总时长 {formatTimecode(total)} · {shots.length} 镜
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {shots.map((s) => (
          <button
            key={s.index}
            type="button"
            onClick={() => onPick(s.index)}
            title={`#${s.index} ${s.shot_type} · ${s.duration}s`}
            className="group shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-left transition-colors hover:border-[var(--accent)]"
            style={{ flexGrow: s.duration, flexBasis: 0, minWidth: 62 }}
          >
            <div className="mono text-[11px] text-[var(--accent)]">
              #{s.index} · {s.duration}s
            </div>
            <div className="truncate text-[11px] text-[var(--muted)]">{s.shot_type}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
