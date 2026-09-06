import { z } from "zod";
import { resolveProfile, type LlmProfile } from "./llm-configs";

/** OpenAI 兼容的多模态消息：纯文本时 content 为 string；带图时为 parts 数组 */
type ChatMsgContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
type ChatMsg = { role: "system" | "user" | "assistant"; content: ChatMsgContent };

export type LLMErrorCode = "CONFIG_MISSING" | "UPSTREAM" | "PARSE" | "TIMEOUT";

export class LLMError extends Error {
  code: LLMErrorCode;
  detail?: string;
  constructor(code: LLMErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
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
    throw new LLMError("UPSTREAM", `LLM 返回 ${res.status}`, raw.slice(0, 800));
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
      try {
        const r = await callChat(profile, messages, {
          jsonMode: v.jsonMode,
          reasoningEffort: v.effort,
          temperature,
          signal: AbortSignal.timeout(timeoutMs),
        });
        content = r.content;
        usage = r.usage;
        break;
      } catch (err) {
        const msg = err instanceof LLMError ? `${err.message} ${err.detail ?? ""}` : String(err);
        const is400 = msg.includes("400");
        // 服务商不认 reasoning_effort → 去掉重试
        if (v.effort && is400 && /reasoning/i.test(msg)) {
          queue.unshift({ jsonMode: v.jsonMode });
          continue;
        }
        // 中转站不认 response_format → 去掉重试
        if (v.jsonMode && is400 && /response_format|json_object|json schema|unsupported/i.test(msg)) {
          queue.unshift({ jsonMode: false, effort: v.effort });
          continue;
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
    return { data: result.data, raw: content, usage };
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new LLMError("TIMEOUT", `LLM 调用超时（${timeoutMs}ms）`, `${baseURL} · ${model}`);
    }
    throw new LLMError("UPSTREAM", `无法连接 LLM（${baseURL}）`, String(err).slice(0, 500));
  }
}
