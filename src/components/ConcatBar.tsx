"use client";

import { useState } from "react";
import type { Shot } from "@/lib/schema";

/**
 * 多镜拼接条（M3a）—— 放在时间轴尾部，把 N 个分镜成片接成一条片子。
 *
 * 拼接是**纯本地**操作（不烧 AI 配额），所以这里没有生成配额的冷却倒计时；
 * 唯一的前置条件是「所有分镜都已有成片」。
 *
 * 前端只负责把「哪一镜用哪个 URL」按顺序报给 /api/concat，下载 + 拼接都在服务端。
 * runId 回传给页面，供后续归档复用（final.mp4 与同一批交付物落同一目录）。
 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtSec(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const m = Math.floor(n / 60);
  const s = (n % 60).toFixed(1);
  return m ? `${m}m ${s}s` : `${s}s`;
}

const MODE_LABEL: Record<string, string> = {
  copy: "无损流拷贝",
  "video-copy-audio-encode": "视频无损 + 音轨重编码",
  reencode: "全重编码",
};

export interface ConcatResultUi {
  runId: string;
  url: string;
  relDir: string;
  mode: string;
  reason: string;
  mismatches: string[];
  bytes: number;
  durationSec: number;
  sourceTotalSec: number;
  probes: Array<{ index: number; width: number; height: number; fps: number; durationSec: number }>;
}

export function ConcatBar({
  shots,
  videoUrls,
  onResult,
}: {
  shots: Shot[];
  /** index → 成片 URL；只有已完成的镜才有 */
  videoUrls: Record<number, string>;
  /** 回传拼接产物（含 runId），页面据此归档 final.mp4 */
  onResult: (r: ConcatResultUi) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConcatResultUi | null>(null);

  const ready = shots.map((s) => Boolean(videoUrls[s.index]));
  const readyCount = ready.filter(Boolean).length;
  const missing = shots.filter((s) => !videoUrls[s.index]);
  const allReady = shots.length > 0 && readyCount === shots.length;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/concat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shots: shots.map((s) => ({ index: s.index, url: videoUrls[s.index] })),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.message ?? "拼接失败");
        return;
      }
      const r = json as ConcatResultUi;
      setResult(r);
      onResult(r);
    } catch (e) {
      setError(`拼接请求失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!shots.length) return null;

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">拼接成片</span>
        <span className="chip mono text-[11px]">
          {readyCount}/{shots.length} 镜已就绪
        </span>
        <span className="text-[11.5px] text-[var(--muted)]">纯本地操作，不烧生成配额</span>

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !allReady}
            title={
              !allReady
                ? `还有 ${missing.length} 镜未生成成片（${missing.map((s) => `#${s.index}`).join("、")}）`
                : undefined
            }
            onClick={() => void run()}
          >
            {busy ? "拼接中…" : allReady ? "拼接成片" : `还差 ${missing.length} 镜`}
          </button>
        </span>
      </div>

      {!allReady ? (
        <div className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
          尚未就绪：{missing.map((s) => `#${s.index}`).join("、")} 还没有成片。逐个在分镜里「生成视频」完成后，再回来拼接。
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--err)" }}>
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip mono text-[11px]" style={{ color: "var(--ok)" }}>
              {MODE_LABEL[result.mode] ?? result.mode}
            </span>
            <span className="mono text-[11px] text-[var(--muted)]">
              {fmtSec(result.durationSec)} · {fmtBytes(result.bytes)}
            </span>
            {result.mode === "reencode" && result.mismatches.length ? (
              <span className="text-[11px]" style={{ color: "var(--warn)" }} title={result.mismatches.join("\n")}>
                参数不一致，已重编码（{result.mismatches.length} 处）
              </span>
            ) : null}
          </div>

          <div className="mt-2">
            <video src={result.url} controls className="max-h-[360px] w-auto rounded-md border border-[var(--border)]" />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a className="btn" href={result.url} target="_blank" rel="noreferrer">
              打开成片
            </a>
            <a className="btn" href={`${result.url}&download=1`} download="final.mp4">
              下载 .mp4
            </a>
            <span className="mono text-[11px] text-[var(--muted)]">{result.relDir}</span>
          </div>

          <details className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
            <summary className="cursor-pointer select-none">拼接明细</summary>
            <div className="mt-1">
              <div>{result.reason}</div>
              <ul className="mt-1 list-inside list-disc">
                {result.probes.map((p) => (
                  <li key={p.index} className="mono">
                    #{p.index} · {p.width}×{p.height} · {p.fps}fps · {fmtSec(p.durationSec)}
                  </li>
                ))}
              </ul>
              {result.mismatches.length ? (
                <ul className="mt-1 list-inside list-disc" style={{ color: "var(--warn)" }}>
                  {result.mismatches.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
