import type { LlmProfile } from "./llm-configs";

/**
 * 视频生成的**厂商无关**类型层。
 *
 * 为什么需要这一层：各厂商的视频接口参数命名、类型、查询方式全都不同，
 * 差异至少覆盖 9 个维度（一手核对 Agnes Video 2.5 文档）：
 *
 * | 维度 | Agnes Video 2.5 / Flash |
 * |---|---|
 * | 创建路径 | `POST /v1/videos` |
 * | 查询路径 | `GET /agnesapi?video_id=&model_name=`（**不在 /v1 下**） |
 * | 时长 | `seconds`，**字符串** `"4"`–`"12"` |
 * | 分辨率 | `size`，**档位** `"720P"`（不是 `1280x720`） |
 * | 画幅 | `aspect_ratio`，与 size 正交的独立字段 |
 * | 模式 | `mode` 必填：`text` / `keyframe` / `reference` |
 * | 首帧 | `first_frame` / `last_frame`（不是 `image`） |
 * | 成片地址 | `metadata.url`，且仅在 `status === "completed"` 时可信 |
 * | 参数风格 | **拒绝** `input_reference` / `video_url` / `width` / `height` / `fps` |
 *
 * 因此路由与 UI 只面对本文件的类型；厂商差异全部收敛在 `VideoProvider` 实现里。
 */

export type VideoErrorCode =
  | "CONFIG_MISSING"
  | "UNKNOWN_PROVIDER"
  | "MODE_MISSING"
  | "BAD_REQUEST"
  | "THROTTLED"
  | "UPSTREAM";

export class VideoError extends Error {
  code: VideoErrorCode;
  detail?: string;
  status?: number;
  /** 上游或本地闸门建议的等待时间（毫秒），用于驱动前端下一次轮询 */
  retryAfterMs?: number;

  constructor(
    code: VideoErrorCode,
    message: string,
    detail?: string,
    status?: number,
    retryAfterMs?: number
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 统一的视频生成请求。字段是「语义」而非「上游字段名」 */
export interface VideoTaskRequest {
  prompt: string;
  /** 时长（秒）。上游类型不一（Agnes 要字符串），由适配器负责转换 */
  seconds?: number;
  /** 画幅，如 "9:16" */
  aspectRatio?: string;
  /** 分辨率档位，如 "720P"；缺省由适配器给默认值 */
  size?: string;
  /** 生成模式；缺省时由适配器按实际传入的媒体字段推断 */
  mode?: string;
  /** 首帧 / 尾帧（keyframe 模式） */
  firstFrame?: string;
  lastFrame?: string;
  /** 参考图 / 参考音频（reference 模式） */
  images?: string[];
  audios?: string[];
  seed?: number;
  /** 平台特有的额外字段，原样透传（不覆盖 model / prompt / mode） */
  extra?: Record<string, unknown>;
}

export type VideoTaskStatus = "queued" | "running" | "completed" | "failed" | "unknown";

export interface VideoCreateResult {
  /** 轮询用 ID（Agnes 为 `video_id`；`id` / `task_id` 是任务 ID，不可混用） */
  taskId: string;
  /** 上游任务 ID，仅用于展示与日志 */
  upstreamId?: string;
  status: VideoTaskStatus;
  progress?: number;
  /** 命中的适配器 id */
  provider: string;
  /** 实际发给上游的模式 */
  mode?: string;
  ms: number;
  raw: unknown;
}

export interface VideoQueryResult {
  status: VideoTaskStatus;
  progress?: number;
  /** 仅 `status === "completed"` 时才有值 */
  videoUrl?: string;
  error?: string;
  ms: number;
  raw: unknown;
}

/** 创建任务的请求构造结果（纯数据，便于单测） */
export interface ProviderCreateRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * 厂商适配器。新增一家视频厂商 = 实现本接口 + 在 `video-providers.ts` 注册表登记一行，
 * 路由、UI、类型层都不需要改。
 */
export interface VideoProvider {
  /** 唯一 id，对应 llm.config.json 里 profile 的 `provider` 字段 */
  id: string;
  /** 人类可读名称，用于报错与 /api/video 的能力自述 */
  label: string;
  /** 按传入的媒体字段推断模式；返回 undefined 表示该厂商没有模式概念 */
  inferMode(req: VideoTaskRequest): string | undefined;
  /** 组装创建请求（纯函数） */
  buildCreate(profile: LlmProfile, req: VideoTaskRequest): ProviderCreateRequest;
  /** 从创建响应中取轮询 ID 与初始状态 */
  parseCreate(raw: unknown): {
    taskId?: string;
    upstreamId?: string;
    status: VideoTaskStatus;
    progress?: number;
  };
  /** 组装查询 URL */
  buildQuery(profile: LlmProfile, taskId: string): string;
  /** 解析查询响应 */
  parseQuery(raw: unknown): {
    status: VideoTaskStatus;
    progress?: number;
    videoUrl?: string;
    error?: string;
  };
}

/* ─────────── 适配器共用的解析工具 ─────────── */

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function pickNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 把各厂商五花八门的状态词归一化到四种 */
export function normalizeStatus(raw: unknown): VideoTaskStatus {
  const s = pickString(raw)?.toLowerCase();
  if (!s) return "unknown";
  if (["queued", "pending", "submitted", "created", "not_started", "waiting"].includes(s)) return "queued";
  if (["in_progress", "running", "processing", "started", "generating"].includes(s)) return "running";
  if (["completed", "succeeded", "success", "done", "finished"].includes(s)) return "completed";
  if (["failed", "error", "canceled", "cancelled", "expired"].includes(s)) return "failed";
  return "unknown";
}

/** 透传 extra，但禁止篡改核心字段（否则会绕过 mode 推断造成 400） */
export function sanitizeExtra(
  extra: Record<string, unknown> | undefined,
  reserved: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || reserved.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 从 baseURL 取 origin（Agnes 的查询端点跳出 /v1，需要拼绝对地址） */
export function originOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return baseURL.replace(/\/v1\/?$/, "");
  }
}
