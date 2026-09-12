import { NextResponse } from "next/server";
import { readTraces, exportFineTune, type TraceRecord } from "@/lib/trace-log";

export const runtime = "nodejs";

/**
 * 链路日志 API（供 /logs 页面与导出用）。
 * GET /api/logs                       → 最近记录（默认 200 条，新→旧）
 * GET /api/logs?traceId=xxx           → 只看某条链路
 * GET /api/logs?limit=500             → 调整条数
 * GET /api/logs?export=1[&traceId=]   → 下载微调 JSONL（messages + completion）
 *
 * 实现：只读日志文件尾部的若干字节（readTraces 的 maxBytes 预算），
 * 不再整文件加载 —— 日志累积到几十 MB 后 /logs 也不会变慢。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const traceId = url.searchParams.get("traceId")?.trim() || "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
  const exportMode = url.searchParams.get("export") === "1";
  /** 尾部扫描窗口：导出/按 traceId 过滤时放宽，保证目标链路的记录都在窗口内 */
  const window = exportMode || traceId ? 2000 : limit;

  const all = readTraces(window);
  const filtered = traceId ? all.filter((r) => r.traceId === traceId) : all;

  if (exportMode) {
    const body = exportFineTune(filtered);
    return new Response(body || "", {
      headers: {
        "Content-Type": "application/jsonl; charset=utf-8",
        "Content-Disposition": `attachment; filename="finetune-${traceId || "all"}.jsonl"`,
      },
    });
  }

  const records: TraceRecord[] = filtered.slice(0, limit);
  return NextResponse.json({
    ok: true,
    total: filtered.length,
    count: records.length,
    /** 尾部窗口内是否还有更多（为 true 表示结果被窗口截断，可调大 limit） */
    truncated: all.length >= window && filtered.length > limit,
    records,
  });
}
