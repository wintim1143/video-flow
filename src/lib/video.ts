import { resolveProfile, type LlmProfile } from "./llm-configs";
import { appendTrace, newTraceId } from "./trace-log";
import {
  checkVideoGate,
  markVideoCall,
  videoCreateMinIntervalMs,
  videoQueryMinIntervalMs,
  type VideoCallKind,
} from "./video-rate-limit";
import { resolveVideoProvider } from "./video-providers";
import {
  VideoError,
  type VideoCreateResult,
  type VideoQueryResult,
  type VideoTaskRequest,
} from "./video-types";

export { VideoError };
export { listProviders, resolveVideoProvider } from "./video-providers";
export { videoGateSnapshot, videoCreateMinIntervalMs, videoQueryMinIntervalMs } from "./video-rate-limit";
export type {
  VideoCreateResult,
  VideoErrorCode,
  VideoProvider,
  VideoQueryResult,
  VideoTaskRequest,
  VideoTaskStatus,
} from "./video-types";

/**
 * 视频生成 facade —— **唯一**对外的调用面。
 *
 * 职责：取 profile → 选适配器 → 过限流闸门 → 发请求 → 交给适配器解析 → 记 trace。
 * 这里不含任何厂商字段名；厂商差异全在 `video-providers.ts`。
 *
 * 与文本/图片链路的关键区别：视频是**异步任务**，一次「生成」= 建任务 + N 次查询。
 * 但两侧配额**量级完全不同**：建任务吃生成配额（免费档 1 次/分钟），查询宽松得多
 * （上游实测 3s 间隔可长期稳定；2s 会周期性撞 429）。所以闸门按调用类型分开：
 * `create` 60s，`query` 3s —— 两者绝不可共用，否则刚建完任务就得干等一分钟才拿得到结果。
 */

const DEFAULT_TIMEOUT_MS = 300_000;

function videoTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const env = Number(process.env.VIDEO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}

/** 取视频 profile；未配置抛 CONFIG_MISSING */
export function getVideoProfile(profileId?: string): LlmProfile {
  const p = resolveProfile("video", profileId);
  if (!p) {
    throw new VideoError(
      "CONFIG_MISSING",
      "未配置视频 LLM。请在项目根 llm.config.json 的 video 组填入 profile（baseURL / apiKey / model，建议补 provider）。"
    );
  }
  return p;
}

/** 解析 Retry-After（支持秒数或 HTTP 日期两种写法） */
function parseRetryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

interface CallParams {
  profile: LlmProfile;
  step: "video.create" | "video.query";
  url: string;
  init: RequestInit;
  timeoutMs: number;
  /** 写进 trace 的 user 字段（即请求摘要，非完整 prompt 时截断） */
  summary: string;
  /** prompt 里是否带图（trace 的 hasImage 标记） */
  hasImage: boolean;
}

/** 过闸门 → 发请求 → 解析 JSON → 记 trace。所有上游交互的唯一出口 */
async function callProvider(p: CallParams): Promise<{ raw: unknown; ms: number }> {
  /* 只有建任务消耗生成配额；查询走独立的宽松闸门 */
  const kind: VideoCallKind = p.step === "video.create" ? "create" : "query";
  const gate = checkVideoGate(kind);
  if (!gate.ok) {
    const what = kind === "create" ? "生成视频" : "查询任务";
    throw new VideoError(
      "THROTTLED",
      `${what}过于频繁：本地最小间隔 ${Math.round(
        (kind === "create" ? videoCreateMinIntervalMs() : videoQueryMinIntervalMs()) / 1000
      )}s，还需等待 ${Math.ceil(gate.retryAfterMs / 1000)}s。`,
      undefined,
      429,
      gate.retryAfterMs
    );
  }
  markVideoCall(kind);

  const traceId = newTraceId();
  const base = {
    traceId,
    step: p.step,
    model: p.profile.model,
    profileId: p.profile.id,
    profileName: p.profile.name,
    temperature: 0,
    hasImage: p.hasImage,
    attempts: 1,
    degraded: [] as string[],
    system: "",
    user: p.summary.slice(0, 4000),
  };

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(p.url, { ...p.init, signal: AbortSignal.timeout(p.timeoutMs) });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    appendTrace({ ...base, ok: false, latencyMs, error: String(err).slice(0, 300) });
    throw new VideoError("UPSTREAM", `无法连接视频服务（${p.profile.baseURL}）`, String(err).slice(0, 500));
  }

  const text = await res.text().catch(() => "");
  const latencyMs = Math.round(performance.now() - started);

  if (!res.ok) {
    appendTrace({ ...base, ok: false, latencyMs, error: `${res.status} ${text.slice(0, 300)}`, raw: text.slice(0, 4000) });
    /* 429：优先用上游给的 Retry-After，没有就退回本类调用的本地最小间隔 */
    const fallbackMs = kind === "create" ? videoCreateMinIntervalMs() : videoQueryMinIntervalMs();
    const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res) ?? fallbackMs : undefined;
    throw new VideoError("UPSTREAM", `视频服务返回 ${res.status}`, text.slice(0, 800), res.status, retryAfterMs);
  }

  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    /* 有的平台直接回 URL 文本，不做 JSON 强解析 */
    raw = text;
  }
  appendTrace({ ...base, ok: true, latencyMs, raw: text.slice(0, 4000) });
  return { raw, ms: latencyMs };
}

/** 建任务。返回的 `taskId` 用于后续查询 */
export async function createVideoTask(
  input: VideoTaskRequest & { profileId?: string; timeoutMs?: number }
): Promise<VideoCreateResult> {
  const profile = getVideoProfile(input.profileId);
  const provider = resolveVideoProvider(profile);
  const { url, body } = provider.buildCreate(profile, input);

  const { raw, ms } = await callProvider({
    profile,
    step: "video.create",
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify(body),
    },
    timeoutMs: videoTimeoutMs(input.timeoutMs),
    summary: JSON.stringify(body),
    hasImage: Boolean(input.firstFrame || input.lastFrame || input.images?.length),
  });

  const parsed = provider.parseCreate(raw);
  if (!parsed.taskId) {
    throw new VideoError(
      "UPSTREAM",
      "上游未返回可用于查询的任务 ID（Agnes 应为 video_id）。",
      JSON.stringify(raw).slice(0, 500)
    );
  }
  return {
    taskId: parsed.taskId,
    upstreamId: parsed.upstreamId,
    status: parsed.status,
    progress: parsed.progress,
    provider: provider.id,
    mode: typeof body.mode === "string" ? body.mode : undefined,
    ms,
    raw,
  };
}

/** 查询任务。`status === "completed"` 时 `videoUrl` 才可信 */
export async function queryVideoTask(input: {
  taskId: string;
  profileId?: string;
  timeoutMs?: number;
}): Promise<VideoQueryResult> {
  const profile = getVideoProfile(input.profileId);
  const provider = resolveVideoProvider(profile);
  const url = provider.buildQuery(profile, input.taskId);

  const { raw, ms } = await callProvider({
    profile,
    step: "video.query",
    url,
    init: { method: "GET", headers: { Authorization: `Bearer ${profile.apiKey}` } },
    timeoutMs: videoTimeoutMs(input.timeoutMs),
    summary: url,
    hasImage: false,
  });

  const parsed = provider.parseQuery(raw);
  return { ...parsed, ms, raw };
}
