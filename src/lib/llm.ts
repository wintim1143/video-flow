import { z } from "zod";
import { resolveProfile, type LlmProfile } from "./llm-configs";
import { appendTrace, newTraceId } from "./trace-log";

/** OpenAI 兼容的多模态消息：纯文本时 content 为 string；带图时为 parts 数组 */
type ChatMsgContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
type ChatMsg = { role: "system" | "user" | "assistant"; content: ChatMsgContent };

export type LLMErrorCode = "CONFIG_MISSING" | "UPSTREAM" | "PARSE" | "TIMEOUT";

export class LLMError extends Error {
  code: LLMErrorCode;
  detail?: string;
  /** 上游 HTTP 状态码（仅 UPSTREAM 时有值），退避重试据此判定 */
  status?: number;
  /** 上游 Retry-After 声明的等待毫秒数（若有） */
  retryAfterMs?: number;
  constructor(code: LLMErrorCode, message: string, detail?: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 上游限流/服务端故障的退避重试次数（**含首次尝试**）；429/5xx/超时适用。
 *
 * 默认 3 = **重试 2 次**，正好对应验收判据 R5.1「每自动环节重试 ≤2 次」。
 * 别把它读成「重试 3 次」—— 变量名是 attempts 不是 retries，口径在这里钉死。
 * 用尽后仍失败时，抛出去的 message 会带上「已重试 N 次」（R5.1 要求的超限告警）。
 */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.LLM_MAX_ATTEMPTS ?? 3));
/** 退避基数（毫秒），按 2^wave 递增并封顶 */
const RETRY_BASE_MS = Math.max(0, Number(process.env.LLM_RETRY_BASE_MS ?? 800));
const RETRY_CAP_MS = 8_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 是否值得重试：429（限流）、5xx（上游故障）、以及无状态码的网络层错误。
 * 400/401/403/404 等客户端错误永不重试（重试也没用，交给降级队列处理）。
 */
function isRetriable(err: unknown): boolean {
  if (err instanceof LLMError) {
    if (err.code === "TIMEOUT") return true; // 超时可能只是抖动
    const st = err.status ?? 0;
    if (st === 429) return true;
    if (st >= 500 && st < 600) return true;
    return false;
  }
  // fetch 网络异常（DNS/连接重置等）
  return true;
}

function retryWaitMs(err: unknown, wave: number): number {
  const hinted = err instanceof LLMError ? err.retryAfterMs : undefined;
  if (hinted && hinted > 0) return Math.min(hinted, RETRY_CAP_MS);
  const backoff = RETRY_BASE_MS * 2 ** wave;
  // 测试里把基数设为 0 时也要保持总等待为 0（不抖到 200ms）
  const jitter = RETRY_BASE_MS > 0 ? Math.random() * 200 : 0;
  return Math.min(backoff + jitter, RETRY_CAP_MS);
}

/** 解析 Retry-After：支持秒数与 HTTP 日期两种格式 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const sec = Number(raw.trim());
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** 取文本 LLM profile；未配置抛 CONFIG_MISSING（含指引） */
function getTextProfile(profileId?: string): LlmProfile {
  const p = resolveProfile("text", profileId);
  if (!p) {
    throw new LLMError(
      "CONFIG_MISSING",
      "未配置文本 LLM。请在项目根目录 llm.config.json 的 text 组填入 profile（或保留 .env.local 的三个值作为默认）。"
    );
  }
  return p;
}

/** 从模型输出里抠出 JSON：兼容 ```json 围栏、前后废话、多个代码块 */
export function extractJson(text: string): unknown {
  let s = text.trim();

  // 去掉 markdown 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 截取第一个 { 到最后一个 }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) s = s.slice(first, last + 1);

  return JSON.parse(s);
}

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 部分推理模型会把思考 token 计入 completion_details */
  reasoning_tokens?: number;
}

async function callChat(
  profile: LlmProfile,
  messages: ChatMsg[],
  opts: { jsonMode: boolean; temperature: number; signal: AbortSignal; reasoningEffort?: string }
): Promise<{ content: string; usage: LlmUsage | null }> {
  const { apiKey, baseURL, model } = profile;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature,
  };
  // 部分中转站不支持 response_format，失败后自动降级重试
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  // 推理模型思考力度：minimal 可把耗时降低一个数量级（服务商不支持时降级重试会去掉）
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new LLMError(
      "UPSTREAM",
      `LLM 返回 ${res.status}`,
      raw.slice(0, 800),
      res.status,
      parseRetryAfter(res.headers.get("retry-after"))
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new LLMError("UPSTREAM", "LLM 返回内容为空", JSON.stringify(data).slice(0, 800));
  }
  const u = data.usage;
  const usage: LlmUsage | null = u
    ? {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens,
        reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
      }
    : null;
  return { content, usage };
}

/** 带图时把多模态 parts 拍平成纯文本（图只留占位符，不进日志文件） */
function flattenUserContent(c: ChatMsgContent): string {
  if (typeof c === "string") return c;
  return c
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join("\n")
    .replace(/^\[image\]/, "[image] ");
}

/**
 * 调一次 chat，拿 JSON 并按 schema 校验。
 * 失败会抛出带 code 的 LLMError，route 层据此映射 HTTP 状态。
 */
export async function chatJSON<T>(params: {
  system: string;
  user: string;
  /** Input 侧放宽为 unknown：允许带 .catch()/.default() 的 schema（Input ≠ Output），T 始终取 Output */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  temperature?: number;
  /** 文本 LLM profile id；缺省用配置里第一个 */
  profileId?: string;
  /** 可选：随消息附带的图片（data URL 或 http URL），走 OpenAI vision 协议 */
  imageUrl?: string;
  /**
   * 可选：链路追踪上下文。传入后本次调用（含降级重试）会落一条日志到
   * .data/traces.jsonl，供 /logs 页面回看与对比。缺省不记录。
   */
  trace?: { traceId: string; step: string };
}): Promise<{ data: T; raw: string; usage: LlmUsage | null }> {
  const profile = getTextProfile(params.profileId);
  const { baseURL, model } = profile;
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 180_000);
  const userContent: ChatMsgContent = params.imageUrl
    ? [
        { type: "image_url", image_url: { url: params.imageUrl } },
        { type: "text", text: params.user },
      ]
    : params.user;
  const messages: ChatMsg[] = [
    { role: "system", content: params.system },
    { role: "user", content: userContent },
  ];
  const temperature = params.temperature ?? 0.7;

  /* 链路追踪：记录尝试次数 / 降级参数 / 总耗时，调用结束后落一条日志 */
  const t0 = performance.now();
  let attempts = 0;
  /** 因 429/5xx/超时而发起的退避重试次数（参数不变，只重发） */
  let retries = 0;
  const degraded: string[] = [];
  const userText = flattenUserContent(userContent);
  const writeLog = (ok: boolean, extra: { raw?: string; error?: string; usage?: LlmUsage | null }) => {
    if (!params.trace) return;
    appendTrace({
      traceId: params.trace.traceId,
      step: params.trace.step,
      model,
      profileId: profile.id,
      profileName: profile.name,
      temperature,
      hasImage: !!params.imageUrl,
      attempts,
      retries,
      degraded,
      ok,
      latencyMs: Math.round(performance.now() - t0),
      raw: extra.raw,
      error: extra.error,
      usage: extra.usage ?? usage,
      system: params.system,
      user: userText,
    });
  };

  let content = "";
  let usage: LlmUsage | null = null;
  try {
    /* reasoning_effort："" 显式关闭；未配置默认 minimal（对推理模型提速一个数量级） */
    const effort =
      profile.reasoningEffort === "" ? undefined : profile.reasoningEffort ?? "minimal";

    /* 降级队列：全量参数 → 按上游报错逐个剥离（reasoning_effort / response_format） */
    const queue: Array<{ jsonMode: boolean; effort?: string }> = [{ jsonMode: true, effort }];
    while (queue.length) {
      const v = queue.shift() as { jsonMode: boolean; effort?: string };
      let r: { content: string; usage: LlmUsage | null };
      try {
        /* 同一组参数内先做退避重试（429/5xx/超时），再交由降级队列处理参数问题 */
        r = await (async () => {
          for (let wave = 0; ; wave++) {
            attempts++;
            try {
              return await callChat(profile, messages, {
                jsonMode: v.jsonMode,
                reasoningEffort: v.effort,
                temperature,
                signal: AbortSignal.timeout(timeoutMs),
              });
            } catch (err) {
              if (!isRetriable(err) || wave >= MAX_ATTEMPTS - 1) throw err;
              retries++;
              await sleep(retryWaitMs(err, wave));
            }
          }
        })();
        content = r.content;
        usage = r.usage;
        break;
      } catch (err) {
        const msg = err instanceof LLMError ? `${err.message} ${err.detail ?? ""}` : String(err);
        const is400 = msg.includes("400");
        // 服务商不认 reasoning_effort → 去掉重试
        if (v.effort && is400 && /reasoning/i.test(msg)) {
          degraded.push("reasoning_effort");
          queue.unshift({ jsonMode: v.jsonMode });
          continue;
        }
        // 中转站不认 response_format → 去掉重试
        if (v.jsonMode && is400 && /response_format|json_object|json schema|unsupported/i.test(msg)) {
          degraded.push("response_format");
          queue.unshift({ jsonMode: false, effort: v.effort });
          continue;
        }
        // 通用 400 参数错误（报错文案不带具体参数名，实测中转站对
        // temperature+response_format+reasoning_effort 组合会拒）→ 逐级降级重试
        if (is400 && /invalid_request|参数错误|invalid/i.test(msg)) {
          if (v.jsonMode) {
            degraded.push("response_format(generic-400)");
            queue.unshift({ jsonMode: false, effort: v.effort });
            continue;
          }
          if (v.effort) {
            degraded.push("reasoning_effort(generic-400)");
            queue.unshift({ jsonMode: false });
            continue;
          }
        }
        throw err;
      }
    }

    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch {
      throw new LLMError("PARSE", "模型输出不是合法 JSON", content.slice(0, 800));
    }

    const result = params.schema.safeParse(parsed);
    if (!result.success) {
      throw new LLMError(
        "PARSE",
        "模型输出字段不符合 schema",
        result.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ")
      );
    }
    writeLog(true, { raw: content, usage });
    return { data: result.data, raw: content, usage };
  } catch (err) {
    const e =
      err instanceof LLMError
        ? err
        : err instanceof Error && err.name === "TimeoutError"
          ? new LLMError("TIMEOUT", `LLM 调用超时（${timeoutMs}ms）`, `${baseURL} · ${model}`)
          : new LLMError("UPSTREAM", `无法连接 LLM（${baseURL}）`, String(err).slice(0, 500));
    writeLog(false, {
      raw: content || undefined,
      error: `${e.code}: ${e.message}${e.detail ? ` | ${e.detail}` : ""}`,
      usage,
    });

    /*
     * R5.1 的「超限告警」：重试用尽这件事必须**显式说出来**。
     * 否则用户看到的只是上游的原始报错（比如一句 502），无从知道自己其实已经被重试过 2 次 ——
     * 也就分不清「上游抖了一下」和「上游持续不可用，该去看看服务了」。
     * 结构化数据（attempts/retries/degraded）已由上面的 writeLog 落进 trace，这里补的是**人话**。
     */
    if (retries > 0) {
      e.message = `${e.message}（已退避重试 ${retries} 次仍失败）`;
    }
    throw e;
  }
}
