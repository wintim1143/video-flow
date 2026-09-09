/**
 * 轻量链路日志（trace log）：
 * 每次 LLM 调用追加一行 JSON 到 .data/traces.jsonl（项目根，gitignored），
 * 用于 /logs 页面回看、两次运行对比、以及微调数据导出。
 *
 * 设计约束：
 * - 零依赖、不 import 项目其他模块（保证可被 node --experimental-strip-types 直接探针测试）
 * - 写入 fire-and-forget：绝不阻塞/拖垮 LLM 主链路，写失败静默（console.debug）
 * - 可用环境变量 TRACE_LOG_DIR 覆盖落盘目录（测试时指向 /tmp，严禁在项目根写真实配置文件）
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

const FILE_NAME = "traces.jsonl";

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成新的 traceId（route 层每个请求调用一次） */
export function newTraceId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 追加一条记录（异步 fire-and-forget；失败静默不影响主链路） */
export function appendTrace(rec: Omit<TraceRecord, "id" | "ts">): void {
  try {
    const dir = traceLogDir();
    const full: TraceRecord = { ...rec, id: newId(), ts: new Date().toISOString() };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, FILE_NAME), `${JSON.stringify(full)}\n`, "utf8");
  } catch (err) {
    console.debug("[trace-log] 写入失败（忽略）:", err);
  }
}

/** 读全部记录（新→旧）；文件不存在返回空数组 */
export function readTraces(): TraceRecord[] {
  try {
    const file = path.join(traceLogDir(), FILE_NAME);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    const out: TraceRecord[] = [];
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as TraceRecord);
      } catch {
        /* 跳过坏行（如进程中断写半行） */
      }
    }
    return out.reverse();
  } catch (err) {
    console.debug("[trace-log] 读取失败:", err);
    return [];
  }
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
