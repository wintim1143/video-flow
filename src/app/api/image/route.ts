import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProfile } from "@/lib/llm-configs";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  profileId: z.string().optional(),
  prompt: z.string().min(1, "prompt 不能为空").max(4000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
});

/**
 * 图片试生成（OpenAI 兼容 /images/generations）。
 * 返回 { kind: "b64", data } 或 { kind: "url", url }，前端自适应展示。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const { profileId, prompt, size } = parsed.data;

  const profile = resolveProfile("image", profileId);
  if (!profile) {
    return NextResponse.json(
      {
        ok: false,
        code: "CONFIG_MISSING",
        message:
          "未配置图片 LLM。请在项目根目录 llm.config.json 的 image 组填入 profile（baseURL / apiKey / model）。",
      },
      { status: 400 }
    );
  }

  const endpoint = profile.endpoint ?? "/images/generations";
  const url = `${profile.baseURL}${endpoint}`;

  const call = async (withFormat: boolean): Promise<Response> => {
    const bodyJson: Record<string, unknown> = { model: profile.model, prompt, n: 1, size };
    if (withFormat) bodyJson.response_format = "b64_json";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify(bodyJson),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 180_000)),
    });
  };

  try {
    let res = await call(true);
    // 部分实现不认 response_format（如 gpt-image-1 系）→ 去掉重试
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (/response_format|unsupported|unknown parameter/i.test(errText) && res.status === 400) {
        res = await call(false);
      } else {
        return NextResponse.json(
          { ok: false, code: "UPSTREAM", message: `图片 API 返回 ${res.status}`, detail: errText.slice(0, 800) },
          { status: 502 }
        );
      }
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, code: "UPSTREAM", message: `图片 API 返回 ${res.status}`, detail: errText.slice(0, 800) },
        { status: 502 }
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = json.data?.[0];
    if (first?.b64_json) {
      return NextResponse.json({ ok: true, data: { kind: "b64", data: first.b64_json, model: profile.model } });
    }
    if (first?.url) {
      return NextResponse.json({ ok: true, data: { kind: "url", url: first.url, model: profile.model } });
    }
    return NextResponse.json(
      { ok: false, code: "UPSTREAM", message: "图片 API 返回中既无 b64_json 也无 url", detail: JSON.stringify(json).slice(0, 500) },
      { status: 502 }
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json(
      {
        ok: false,
        code: isTimeout ? "TIMEOUT" : "UPSTREAM",
        message: isTimeout ? "图片生成超时" : `无法连接图片 API（${profile.baseURL}）`,
        detail: String(err).slice(0, 500),
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
