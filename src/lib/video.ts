import { resolveProfile, type LlmProfile } from "./llm-configs";

/**
 * 视频生成客户端（M1 接线层）。
 *
 * 现状：M0 承诺「不生视频」，因此**没有 UI 入口**，只把视频 profile 接到代码里，
 * 供 M1 或脚本直接调用。
 *
 * 各平台参数命名不一（Agnes Video 要求必填 `mode`，取值随平台/模式而变），
 * 所以本层不做任何猜测：`mode` 只从配置（llm.config.json 的 video profile `mode` 字段）
 * 或调用方显式传入，缺失时直接给出可操作的报错，而不是硬编码一个可能错的值。
 */

export type VideoErrorCode = "CONFIG_MISSING" | "MODE_MISSING" | "UPSTREAM";

export class VideoError extends Error {
  code: VideoErrorCode;
  detail?: string;
  status?: number;
  constructor(code: VideoErrorCode, message: string, detail?: string, status?: number) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export interface VideoGenInput {
  prompt: string;
  /** 图生视频的首帧（data URL 或 http URL） */
  imageUrl?: string;
  /** 覆盖 profile.mode 的取值 */
  mode?: string;
  /** 透传给上游的可选参数（duration / resolution / aspect_ratio / seed…，各平台命名不同） */
  extra?: Record<string, unknown>;
}

/** 取视频 profile；未配置抛 CONFIG_MISSING */
export function getVideoProfile(profileId?: string): LlmProfile {
  const p = resolveProfile("video", profileId);
  if (!p) {
    throw new VideoError(
      "CONFIG_MISSING",
      "未配置视频 LLM。请在项目根 llm.config.json 的 video 组填入 profile（baseURL / apiKey / model，必要时补 endpoint 与 mode）。"
    );
  }
  return p;
}

/**
 * 纯函数：组装视频生成请求体（不发网络请求，便于单测）。
 * 必填：model + prompt + mode；有首帧图时带 image。
 */
export function buildVideoBody(profile: LlmProfile, input: VideoGenInput): Record<string, unknown> {
  const mode = input.mode?.trim() || profile.mode;
  if (!mode) {
    throw new VideoError(
      "MODE_MISSING",
      `视频 profile「${profile.name}」缺少 mode 取值。请在 llm.config.json 的该 profile 里补 "mode" 字段（取值见服务商文档，如 Agnes Video 的请求示例），或在请求里显式传 mode。`
    );
  }
  const body: Record<string, unknown> = { model: profile.model, prompt: input.prompt, mode };
  if (input.imageUrl) body.image = input.imageUrl;
  if (input.extra) {
    for (const [k, v] of Object.entries(input.extra)) {
      if (v !== undefined && k !== "model" && k !== "prompt" && k !== "mode") body[k] = v;
    }
  }
  return body;
}

export interface VideoGenResult {
  /** 上游返回的 JSON（同步出片或异步任务，形态随平台而定，原样透出） */
  raw: unknown;
  ms: number;
  mode: string;
}

/** 调一次视频生成（POST {baseURL}{endpoint ?? "/videos"}） */
export async function generateVideo(
  input: VideoGenInput & { profileId?: string; timeoutMs?: number }
): Promise<VideoGenResult> {
  const profile = getVideoProfile(input.profileId);
  const body = buildVideoBody(profile, input);
  const timeoutMs = input.timeoutMs ?? Number(process.env.VIDEO_TIMEOUT_MS ?? 300_000);
  const endpoint = profile.endpoint || "/videos";
  const started = performance.now();

  let res: Response;
  try {
    res = await fetch(`${profile.baseURL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new VideoError("UPSTREAM", `无法连接视频服务（${profile.baseURL}）`, String(err).slice(0, 500));
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new VideoError("UPSTREAM", `视频服务返回 ${res.status}`, text.slice(0, 800), res.status);
  }

  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    // 有的平台直接回 URL 文本，不做 JSON 强解析
    raw = text;
  }
  return { raw, ms: Math.round(performance.now() - started), mode: String(body.mode) };
}
