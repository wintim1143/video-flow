import { z } from "zod";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

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

function readConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 180_000);

  const missing: string[] = [];
  if (!apiKey || apiKey.startsWith("sk-xxxx")) missing.push("LLM_API_KEY");
  if (!baseURL || baseURL.includes("your-gateway")) missing.push("LLM_BASE_URL");
  if (!model) missing.push("LLM_MODEL");
  if (missing.length) {
    throw new LLMError(
      "CONFIG_MISSING",
      `未配置 ${missing.join("、")}。请编辑项目根目录 .env.local 后重启 dev server。`
    );
  }
  return {
    apiKey: apiKey as string,
    baseURL: (baseURL as string).replace(/\/+$/, ""),
    model: model as string,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 180_000,
  };
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

async function callChat(
  messages: ChatMsg[],
  opts: { jsonMode: boolean; temperature: number; signal: AbortSignal }
): Promise<string> {
  const { apiKey, baseURL, model } = readConfig();

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature,
  };
  // 部分中转站不支持 response_format，失败后自动降级重试
  if (opts.jsonMode) body.response_format = { type: "json_object" };

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
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new LLMError("UPSTREAM", "LLM 返回内容为空", JSON.stringify(data).slice(0, 800));
  }
  return content;
}

/**
 * 调一次 chat，拿 JSON 并按 schema 校验。
 * 失败会抛出带 code 的 LLMError，route 层据此映射 HTTP 状态。
 */
export async function chatJSON<T>(params: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
}): Promise<{ data: T; raw: string }> {
  const { baseURL, model, timeoutMs } = readConfig();
  const messages: ChatMsg[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const temperature = params.temperature ?? 0.7;

  let content = "";
  try {
    try {
      content = await callChat(messages, {
        jsonMode: true,
        temperature,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 中转站不认 response_format → 去掉重试一次
      const msg = err instanceof LLMError ? `${err.message} ${err.detail ?? ""}` : String(err);
      const unsupportedJsonMode =
        /response_format|json_object|json schema|unsupported/i.test(msg) && msg.includes("400");
      if (!unsupportedJsonMode) throw err;
      content = await callChat(messages, {
        jsonMode: false,
        temperature,
        signal: AbortSignal.timeout(timeoutMs),
      });
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
    return { data: result.data, raw: content };
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new LLMError("TIMEOUT", `LLM 调用超时（${timeoutMs}ms）`, `${baseURL} · ${model}`);
    }
    throw new LLMError("UPSTREAM", `无法连接 LLM（${baseURL}）`, String(err).slice(0, 500));
  }
}
