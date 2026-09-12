import type { LlmProfile } from "./llm-configs";
import {
  VideoError,
  asRecord,
  normalizeStatus,
  originOf,
  pickNumber,
  pickString,
  sanitizeExtra,
  type ProviderCreateRequest,
  type VideoProvider,
  type VideoTaskRequest,
  type VideoTaskStatus,
} from "./video-types";

/**
 * 视频厂商适配器注册表。
 *
 * 新增一家厂商的完整步骤：
 *   1. 在下面写一个 `VideoProvider` 实现（buildCreate / parseCreate / buildQuery / parseQuery / inferMode）
 *   2. 加进 `PROVIDERS`
 *   3. 在 llm.config.json 的 video profile 里把 `provider` 指向它的 id
 * 路由、UI、统一类型层都不需要改动。
 */

/**
 * Agnes Video 2.5 / 2.5 Flash —— 已按官方文档逐字段核对。
 *
 * 文档：https://www.agnes-ai.cn/zh-Hans/docs/agnes-video-25
 *      https://www.agnes-ai.cn/zh-Hans/docs/agnes-video-25-flash
 *
 * 关键差异（也是「必须适配」的直接证据）：
 * - 查询端点 `/agnesapi` **不在 `/v1` 下**，且参数走 query string
 * - `seconds` 是字符串 `"4"`–`"12"`，`size` 是档位字符串（Flash 强制 `"720P"`）
 * - `mode` 必填且必须与实际传入的媒体字段匹配，否则 400
 * - 成片地址在 `metadata.url`
 */
export const agnesProvider: VideoProvider = {
  id: "agnes",
  label: "Agnes Video（POST /videos 建任务 + GET /agnesapi 查询）",

  /** 文档「生成模式规则」表：有首/尾帧 → keyframe；有参考图/音频 → reference；否则 text */
  inferMode(req: VideoTaskRequest) {
    if (req.firstFrame || req.lastFrame) return "keyframe";
    if (req.images?.length || req.audios?.length) return "reference";
    return "text";
  },

  buildCreate(profile, req) {
    const mode = req.mode?.trim() || profile.mode?.trim() || agnesProvider.inferMode(req) || "text";
    const body: Record<string, unknown> = { model: profile.model, prompt: req.prompt, mode };

    /* 时长：上游要字符串。超范围直接拦在本地，避免浪费一次配额换 400 */
    if (req.seconds !== undefined) {
      if (!Number.isFinite(req.seconds) || req.seconds < 4 || req.seconds > 12) {
        throw new VideoError(
          "BAD_REQUEST",
          `时长 ${req.seconds}s 超出 Agnes 支持范围（4–12 秒）。请调整分镜时长或改用其它厂商。`
        );
      }
      body.seconds = String(req.seconds);
    }

    /* 分辨率档位：Flash 只接受 720P；2.5 还支持 1080P / 1K / 2K */
    body.size = req.size?.trim() || "720P";
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.seed !== undefined) body.seed = req.seed;

    /* 模式专用字段：传错模式的字段会被 400 打回（文档「不允许的媒体字段」列） */
    if (mode === "keyframe") {
      if (req.firstFrame) body.first_frame = req.firstFrame;
      if (req.lastFrame) body.last_frame = req.lastFrame;
      if (!req.firstFrame && !req.lastFrame) {
        throw new VideoError("BAD_REQUEST", "keyframe 模式必须提供 firstFrame 或 lastFrame。");
      }
    } else if (mode === "reference") {
      if (req.images?.length) body.images = req.images;
      if (req.audios?.length) body.audios = req.audios;
      if (!body.images && !body.audios) {
        throw new VideoError("BAD_REQUEST", "reference 模式必须提供 images 或 audios。");
      }
    }

    Object.assign(body, sanitizeExtra(req.extra, ["model", "prompt", "mode", "seconds", "size"]));

    return {
      url: `${profile.baseURL}${profile.endpoint || "/videos"}`,
      body,
    } satisfies ProviderCreateRequest;
  },

  parseCreate(raw) {
    const r = asRecord(raw);
    return {
      /* video_id 才能用于查询；id / task_id 只是任务 ID，混用会 404 */
      taskId: pickString(r.video_id) ?? pickString(r.id) ?? pickString(r.task_id),
      upstreamId: pickString(r.task_id) ?? pickString(r.id),
      status: normalizeStatus(r.status),
      progress: pickNumber(r.progress),
    };
  },

  buildQuery(profile, taskId) {
    /* 文档：全部模式推荐带 model_name 查询；不带 model_name 仅 text 模式可用 */
    const q = new URLSearchParams({ video_id: taskId, model_name: profile.model });
    return `${originOf(profile.baseURL)}/agnesapi?${q.toString()}`;
  },

  parseQuery(raw) {
    const r = asRecord(raw);
    const status: VideoTaskStatus = normalizeStatus(r.status);
    const meta = asRecord(r.metadata);
    const firstData = Array.isArray(r.data) ? asRecord(r.data[0]) : {};
    const err = asRecord(r.error);
    return {
      status,
      progress: pickNumber(r.progress),
      /* 文档写的是 metadata.url，但实测 apihub.agnes-ai.com 的 completed 响应
       * **只有顶层 url，且完全没有 metadata 字段** —— 两个位置都要认。 */
      videoUrl:
        status === "completed"
          ? pickString(meta.url) ?? pickString(r.url) ?? pickString(firstData.url)
          : undefined,
      error: status === "failed" ? pickString(err.message) ?? "上游返回 failed 但未给出错误信息" : undefined,
    };
  },
};

/**
 * 通用 OpenAI Videos 形态的兜底适配器（Sora 及宣称兼容它的服务商）。
 *
 * ⚠️ 未逐家核对文档，只覆盖最常见的形态：`POST /videos` + `GET /videos/{id}`。
 * 接新厂商时优先照其文档写一个专用适配器，而不是依赖这一层。
 */
export const openaiCompatProvider: VideoProvider = {
  id: "openai",
  label: "通用 OpenAI Videos 兼容（POST /videos + GET /videos/{id}）",

  /** OpenAI Videos 形态没有 mode 概念 */
  inferMode() {
    return undefined;
  },

  buildCreate(profile, req) {
    const body: Record<string, unknown> = { model: profile.model, prompt: req.prompt };
    if (req.seconds !== undefined) body.seconds = String(req.seconds);
    if (req.size) body.size = req.size;
    if (req.firstFrame) body.input_reference = req.firstFrame;
    Object.assign(body, sanitizeExtra(req.extra, ["model", "prompt", "seconds", "size"]));
    return {
      url: `${profile.baseURL}${profile.endpoint || "/videos"}`,
      body,
    } satisfies ProviderCreateRequest;
  },

  parseCreate(raw) {
    const r = asRecord(raw);
    return {
      taskId: pickString(r.id) ?? pickString(r.video_id) ?? pickString(r.task_id),
      upstreamId: pickString(r.task_id),
      status: normalizeStatus(r.status),
      progress: pickNumber(r.progress),
    };
  },

  buildQuery(profile, taskId) {
    return `${profile.baseURL}/videos/${encodeURIComponent(taskId)}`;
  },

  parseQuery(raw) {
    const r = asRecord(raw);
    const status = normalizeStatus(r.status);
    const meta = asRecord(r.metadata);
    const firstData = Array.isArray(r.data) ? asRecord(r.data[0]) : {};
    const err = asRecord(r.error);
    return {
      status,
      progress: pickNumber(r.progress),
      videoUrl:
        status === "completed"
          ? pickString(meta.url) ?? pickString(firstData.url) ?? pickString(r.url)
          : undefined,
      error: status === "failed" ? pickString(err.message) ?? "上游返回 failed" : undefined,
    };
  },
};

export const PROVIDERS: VideoProvider[] = [agnesProvider, openaiCompatProvider];

/** 注册表自述，给 /api/video 的 GET 用（前端下拉/报错提示都读它） */
export function listProviders(): Array<{ id: string; label: string }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * 选定适配器：优先 profile.provider 显式声明；
 * 未声明时按 baseURL 猜（含 agnes 字样的走 agnes），避免漏填配置就直接跑不起来。
 */
export function resolveVideoProvider(profile: Pick<LlmProfile, "baseURL" | "provider">): VideoProvider {
  const explicit = profile.provider?.trim().toLowerCase();
  if (explicit) {
    const hit = PROVIDERS.find((p) => p.id === explicit);
    if (hit) return hit;
    throw new VideoError(
      "UNKNOWN_PROVIDER",
      `未知的视频厂商「${explicit}」。可选：${PROVIDERS.map((p) => p.id).join(" / ")}。请在 llm.config.json 的该 profile 里修正 provider，或按文档新增一个适配器。`
    );
  }
  if (/agnes/i.test(profile.baseURL)) return agnesProvider;
  return openaiCompatProvider;
}
