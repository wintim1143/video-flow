/**
 * 轻量链路日志（trace log）：
 * 每次 LLM 调用追加一行 JSON 到 .data/traces-YYYY-MM.jsonl（项目根，gitignored），
 * 用于 /logs 页面回看、两次运行对比、以及微调数据导出。
 *
 * 设计约束：
 * - 零依赖、不 import 项目其他模块（保证可被 node --experimental-strip-types 直接探针测试）
 * - 写入 fire-and-forget：绝不阻塞/拖垮 LLM 主链路，写失败静默（console.debug）
 * - 可用环境变量 TRACE_LOG_DIR 覆盖落盘目录（测试时指向 /tmp，严禁在项目根写真实配置文件）
 * - 按月分文件轮转，读取时只读「尾部若干字节」而非全量加载（避免日志长大拖慢 /logs）
 */

import fs from "node:fs";
import path from "node:path";

export interface TraceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

/** 一次（逻辑上的）LLM 调用的完整记录 */
export interface TraceRecord {
  /** 单条记录 id（一次 chatJSON 调用一条） */
  id: string;
  /** 链路 id：同一次用户操作（提风格 / 生成分镜全程）共用一个 traceId */
  traceId: string;
  /** 步骤名：style | outline | shot_1 | shot_retry:2 … */
  step: string;
  /** ISO 时间 */
  ts: string;
  model: string;
  profileId: string;
  profileName: string;
  temperature: number;
  /** 是否带图片输入（只记布尔，不落 base64） */
  hasImage: boolean;
  /** 服务端降级队列实际执行的尝试次数（1=一次成功，>1=发生过降级重试） */
  attempts: number;
  /** 因上游 429/5xx/超时而发起的退避重试次数（不改变参数，只重发） */
  retries?: number;
  /** 被剥离的参数，如 ["reasoning_effort", "response_format"] */
  degraded: string[];
  ok: boolean;
  latencyMs: number;
  /** 成功时的模型原始输出（未抠 JSON 前） */
  raw?: string;
  /** 失败时的错误描述（code + message + detail） */
  error?: string;
  usage?: TraceUsage | null;
  /** 完整 prompt（system + user；带图时 user 文本前标注 [image]） */
  system: string;
  user: string;
}

/** 落盘目录：项目根 .data/，可被 TRACE_LOG_DIR 覆盖 */
export function traceLogDir(): string {
  const env = process.env.TRACE_LOG_DIR?.trim();
  if (env) return env;
  return `${process.cwd()}/.data`;
}

/** 历史遗留的单文件命名（改造前所有记录都写这里，读取时仍兼容） */
const LEGACY_FILE_NAME = "traces.jsonl";
/** 按月轮转：traces-YYYY-MM.jsonl */
const MONTHLY_RE = /^traces-\d{4}-\d{2}\.jsonl$/;

/** 当月文件名（UTC 月份，避免本地时区跨月歧义） */
export function monthFileName(d = new Date()): string {
  return `traces-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成新的 traceId（route 层每个请求调用一次） */
export function newTraceId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 追加一条记录（同步 fire-and-forget；失败静默不影响主链路） */
export function appendTrace(rec: Omit<TraceRecord, "id" | "ts">): void {
  try {
    const dir = traceLogDir();
    const full: TraceRecord = { ...rec, id: newId(), ts: new Date().toISOString() };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, monthFileName()), `${JSON.stringify(full)}\n`, "utf8");
  } catch (err) {
    console.debug("[trace-log] 写入失败（忽略）:", err);
  }
}

/** 列出日志文件，新 → 旧（历史单文件排在最后） */
function listTraceFiles(): string[] {
  const dir = traceLogDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const monthly = names.filter((n) => MONTHLY_RE.test(n)).sort().reverse();
  const legacy = names.includes(LEGACY_FILE_NAME) ? [LEGACY_FILE_NAME] : [];
  return [...monthly, ...legacy].map((n) => path.join(dir, n));
}

/**
 * 读取文件尾部的若干字节（不整文件加载）。
 * truncated=true 表示只读了尾部，**首行可能是半行**，调用方需丢弃。
 */
function readTailLines(file: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return { lines: [], truncated: false };
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { lines: buf.toString("utf8").split("\n"), truncated: start > 0 };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function parseLine(line: string): TraceRecord | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as TraceRecord;
  } catch {
    return null; // 跳过坏行（如进程中断写半行）
  }
}

/**
 * 读最近的记录（新 → 旧）。
 * 只读尾部字节：`maxBytes` 默认 4MB，够放下数千条；跨月时从新月份文件往前凑满 `limit` 条。
 */
export function readTraces(limit = 500, maxBytes = 4_000_000): TraceRecord[] {
  const out: TraceRecord[] = [];
  try {
    for (const file of listTraceFiles()) {
      if (out.length >= limit) break;
      const { lines, truncated } = readTailLines(file, maxBytes);
      // 只读了尾部时首行可能被截断成半行，丢弃；完整读取时首行有效，保留
      const usable = truncated ? lines.slice(1) : lines;
      const recs: TraceRecord[] = [];
      for (const line of usable) {
        const r = parseLine(line);
        if (r) recs.push(r);
      }
      out.push(...recs.reverse());
    }
  } catch (err) {
    console.debug("[trace-log] 读取失败:", err);
  }
  return out.slice(0, limit);
}

/** 导出微调 JSONL：每条 { messages: [system, user], completion } */
export function exportFineTune(records: TraceRecord[]): string {
  const lines: string[] = [];
  for (const r of records) {
    if (!r.ok || !r.raw) continue;
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: r.system },
          { role: "user", content: r.user },
        ],
        completion: r.raw,
        meta: { step: r.step, model: r.model, traceId: r.traceId, ts: r.ts },
      })
    );
  }
  return lines.join("\n");
}
