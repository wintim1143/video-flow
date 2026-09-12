"use client";

/**
 * /logs — 链路日志页面（轻量观测）：
 * 1. 列表：每次 LLM 调用一条（时间/步骤/模型/耗时/token/成败）
 * 2. 详情：完整 prompt、模型原始输出、报错、降级记录
 * 3. 对比：勾选两条记录左右并排（微调前后 / 换模型对比的核心用法）
 * 4. 导出：下载微调 JSONL（messages + completion）
 */

import { useCallback, useEffect, useMemo, useState } from "react";

interface TraceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

interface TraceRecord {
  id: string;
  traceId: string;
  step: string;
  ts: string;
  model: string;
  profileId: string;
  profileName: string;
  temperature: number;
  hasImage: boolean;
  attempts: number;
  /** 因 429/5xx/超时发起的退避重试次数（attempts - 1 通常等于它，但有降级重发时不等） */
  retries?: number;
  degraded: string[];
  ok: boolean;
  latencyMs: number;
  raw?: string;
  error?: string;
  usage?: TraceUsage | null;
  system: string;
  user: string;
}

const STEP_LABEL: Record<string, string> = {
  style: "风格匹配",
  style_from_image: "图提取风格",
  outline: "分镜大纲",
};

function stepLabel(s: string): string {
  if (STEP_LABEL[s]) return STEP_LABEL[s];
  const m = s.match(/^shot_retry:(\d+)$/);
  if (m) return `单镜重试·第${m[1]}镜`;
  const m2 = s.match(/^shot_(\d+)$/);
  if (m2) return `第${m2[1]}镜`;
  return s;
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtSec(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function LogsPage() {
  const [records, setRecords] = useState<TraceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [traceFilter, setTraceFilter] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // 对比选择，最多 2 条

  const load = useCallback(async (tf: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/logs?limit=500${tf ? `&traceId=${encodeURIComponent(tf)}` : ""}`);
      const j = (await res.json()) as { ok: boolean; total: number; records: TraceRecord[] };
      if (j.ok) {
        setRecords(j.records);
        setTotal(j.total);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(traceFilter);
  }, [load, traceFilter]);

  const detail = useMemo(() => records.find((r) => r.id === detailId) ?? null, [records, detailId]);
  const pickedRecords = useMemo(() => picked.map((id) => records.find((r) => r.id === id)!).filter(Boolean), [picked, records]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const next = [...prev, id];
      return next.length > 2 ? next.slice(next.length - 2) : next;
    });
  };

  return (
    <main className="mx-auto max-w-[1180px] px-6 py-6">
      {/* 顶栏 */}
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[16px] font-semibold tracking-tight">
            链路<span style={{ color: "var(--accent)" }}>日志</span>
          </h1>
          <p className="text-[11.5px] text-[var(--muted)]">
            每次 LLM 调用的完整记录（prompt / 原始输出 / 耗时 / token），落盘 .data/traces.jsonl
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {traceFilter && (
            <button
              type="button"
              onClick={() => setTraceFilter("")}
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] hover:text-[var(--text)]"
            >
              返回全部（共 {total} 条）
            </button>
          )}
          <a
            href={`/api/logs?export=1${traceFilter ? `&traceId=${encodeURIComponent(traceFilter)}` : ""}`}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] hover:text-[var(--text)]"
            title="下载微调格式 JSONL（messages + completion）"
          >
            导出微调 JSONL
          </a>
          <a
            href="/"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            ← 返回工作台
          </a>
        </div>
      </header>

      {/* 对比提示条 */}
      {pickedRecords.length > 0 && (
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12.5px]">
          已选 {pickedRecords.length}/2 条用于对比
          {pickedRecords.length === 2 && " · 对比视图见下方"}
          <button type="button" onClick={() => setPicked([])} className="ml-3 text-[var(--muted)] underline hover:text-[var(--text)]">
            清空选择
          </button>
        </div>
      )}

      {/* 对比视图（左右并排） */}
      {pickedRecords.length === 2 && (
        <section className="mb-5 grid grid-cols-2 gap-3">
          {pickedRecords.map((r) => (
            <div key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="mb-2 flex items-center gap-2 text-[12px]">
                <span className="font-medium">{fmtTime(r.ts)}</span>
                <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[11px]" style={{ color: "var(--accent)" }}>
                  {stepLabel(r.step)}
                </span>
                <span className="text-[var(--muted)]">{r.profileName}</span>
                <span className="ml-auto text-[var(--muted)]">
                  {fmtSec(r.latencyMs)} · {r.usage?.total_tokens ?? "-"} tok
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11.5px] text-[var(--muted)]">
                <span>温度 {r.temperature}</span>
                <span>尝试 {r.attempts} 次{r.retries ? ` · 重试 ${r.retries}` : ""}</span>
                <span>{r.degraded.length ? `降级: ${r.degraded.join("/")}` : "无降级"}</span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] text-[var(--muted)]">System Prompt</summary>
                <pre className="mono mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-2 text-[11px] leading-relaxed">{r.system}</pre>
              </details>
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-[var(--muted)]">User Prompt{r.hasImage ? "（含图）" : ""}</summary>
                <pre className="mono mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-2 text-[11px] leading-relaxed">{r.user}</pre>
              </details>
              <details open className="mt-1">
                <summary className="cursor-pointer text-[12px] text-[var(--muted)]">模型输出</summary>
                <pre className="mono mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-2 text-[11px] leading-relaxed">{r.ok ? r.raw : `❌ ${r.error}`}</pre>
              </details>
            </div>
          ))}
        </section>
      )}

      {/* 列表 */}
      <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11.5px] text-[var(--muted)]">
              <th className="w-10 px-3 py-2 font-normal">对比</th>
              <th className="px-3 py-2 font-normal">时间</th>
              <th className="px-3 py-2 font-normal">步骤</th>
              <th className="px-3 py-2 font-normal">模型</th>
              <th className="px-3 py-2 font-normal">状态</th>
              <th className="px-3 py-2 font-normal">耗时</th>
              <th className="px-3 py-2 font-normal">tokens</th>
              <th className="px-3 py-2 font-normal">链路</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--muted)]">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && !records.length && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--muted)]">
                  暂无记录。生成一次风格或分镜后，这里就会出现调用日志。
                </td>
              </tr>
            )}
            {!loading &&
              records.map((r) => (
                <tr
                  key={r.id}
                  className={`cursor-pointer border-b border-[var(--border)]/60 hover:bg-black/[0.03] ${detailId === r.id ? "bg-black/[0.04]" : ""}`}
                  onClick={() => setDetailId(detailId === r.id ? null : r.id)}
                >
                  <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={picked.includes(r.id)}
                      onChange={() => togglePick(r.id)}
                      title="勾选两条记录进行对比"
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[var(--muted)]">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1.5">{stepLabel(r.step)}</td>
                  <td className="max-w-[180px] truncate px-3 py-1.5 text-[var(--muted)]" title={r.profileName}>
                    {r.profileName}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.ok ? (
                      <span className="text-[12px]" style={{ color: "#1a9a5c" }}>
                        成功
                      </span>
                    ) : (
                      <span className="text-[12px]" style={{ color: "#d4494d" }}>
                        失败
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[var(--muted)]">{fmtSec(r.latencyMs)}</td>
                  <td className="px-3 py-1.5 text-[var(--muted)]">{r.usage?.total_tokens ?? "-"}</td>
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      className="mono text-[11px] text-[var(--muted)] underline hover:text-[var(--text)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTraceFilter(r.traceId);
                      }}
                      title="只看这条链路（大纲+各镜）"
                    >
                      {r.traceId.slice(0, 12)}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      {/* 单条详情 */}
      {detail && (
        <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px]">
            <span className="font-medium">{fmtTime(detail.ts)}</span>
            <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[11px]" style={{ color: "var(--accent)" }}>
              {stepLabel(detail.step)}
            </span>
            <span className="text-[var(--muted)]">{detail.profileName}</span>
            <span className="text-[var(--muted)]">温度 {detail.temperature}</span>
            <span className="text-[var(--muted)]">
              尝试 {detail.attempts} 次
              {detail.retries ? ` · 重试 ${detail.retries}` : ""}
            </span>
            {detail.degraded.length > 0 && <span className="text-[var(--muted)]">降级: {detail.degraded.join(" → ")}</span>}
            <span className="ml-auto text-[var(--muted)]">
              {fmtSec(detail.latencyMs)} · prompt {detail.usage?.prompt_tokens ?? "-"} / completion {detail.usage?.completion_tokens ?? "-"}
              {detail.usage?.reasoning_tokens ? ` / reasoning ${detail.usage.reasoning_tokens}` : ""}
            </span>
          </div>
          <details className="mb-1">
            <summary className="cursor-pointer text-[12.5px] text-[var(--muted)]">System Prompt</summary>
            <pre className="mono mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-3 text-[11.5px] leading-relaxed">{detail.system}</pre>
          </details>
          <details className="mb-1">
            <summary className="cursor-pointer text-[12.5px] text-[var(--muted)]">User Prompt{detail.hasImage ? "（含参考图，图不落盘）" : ""}</summary>
            <pre className="mono mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-3 text-[11.5px] leading-relaxed">{detail.user}</pre>
          </details>
          <details open>
            <summary className="cursor-pointer text-[12.5px] text-[var(--muted)]">{detail.ok ? "模型原始输出" : "错误详情"}</summary>
            <pre className={`mono mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[11.5px] leading-relaxed ${detail.ok ? "bg-black/[0.04]" : "bg-[#d4494d]/10"}`}>
              {detail.ok ? detail.raw : detail.error}
            </pre>
          </details>
        </section>
      )}
    </main>
  );
}
