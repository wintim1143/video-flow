import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProfile } from "@/lib/llm-configs";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  profileId: z.string().optional(),
  prompt: z.string().min(1, "prompt 不能为空").max(4000),
  /**
   * 尺寸。三个预设是给风格样张的下拉用的；关键帧走「与视频画布严格对齐」的
   * 精确尺寸（如 720×1280），所以这里放开为任意 `宽x高`。
   * 实测 Agnes 图片接口接受任意尺寸（1024x1792 / 720x1280 / 768x1344 均 200）。
   */
  size: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, "尺寸格式应为 宽x高，如 720x1280")
    .default("1024x1024"),
  /**
   * 优先返回 URL 而非 base64。
   *
   * **关键帧必须为 true**：下游 I2V 要求首帧是上游能自己拉取的公网图片地址，
   * base64 字符串它读不了。风格样张只需前端显示，用 b64 即可（缺省行为，保持不变）。
   */
  preferUrl: z.boolean().optional(),
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
  const { profileId, prompt, size, preferUrl } = parsed.data;

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

  /**
   * `response_format` 的三种取值。**实测（Agnes 图片接口）有个坑**：
   * 一旦传 `response_format: "b64_json"`，网关就**不再返回 `url` 字段**了 ——
   * 明明不传时两个都给。所以「要 URL」的调用方绝不能带 `b64_json`。
   *
   *   "auto" → 完全不传 response_format（网关默认，实测 url + b64_json 都给）
   *   "url"  → 显式要 url
   *   "b64"  → 显式要 b64_json（此时不会有 url）
   */
  type FormatPref = "auto" | "url" | "b64";

  const call = async (format: FormatPref): Promise<Response> => {
    const bodyJson: Record<string, unknown> = { model: profile.model, prompt, n: 1, size };
    if (format !== "auto") bodyJson.response_format = format === "b64" ? "b64_json" : "url";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify(bodyJson),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 180_000)),
    });
  };

  /* 要 URL 就先走 auto（不带 response_format）；否则维持原有行为：先 b64，再降级 auto */
  const attempts: FormatPref[] = preferUrl === true ? ["auto", "url"] : ["b64", "auto"];

  try {
    let res: Response | null = null;
    let lastErrText = "";
    for (const format of attempts) {
      const r = await call(format);
      if (r.ok) {
        res = r;
        break;
      }
      lastErrText = await r.text().catch(() => "");
      /* 只有「参数不被支持」这一类 400 才值得换个 response_format 重试 */
      const retriable =
        r.status === 400 && /response_format|unsupported|unknown parameter|invalid.*format/i.test(lastErrText);
      if (!retriable) {
        return NextResponse.json(
          { ok: false, code: "UPSTREAM", message: `图片 API 返回 ${r.status}`, detail: lastErrText.slice(0, 800) },
          { status: 502 }
        );
      }
    }
    if (!res) {
      return NextResponse.json(
        { ok: false, code: "UPSTREAM", message: "图片 API 拒绝了所有 response_format 取值", detail: lastErrText.slice(0, 800) },
        { status: 502 }
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = json.data?.[0];
    const outUrl = first?.url;
    const outB64 = first?.b64_json;
    if (!outUrl && !outB64) {
      return NextResponse.json(
        { ok: false, code: "UPSTREAM", message: "图片 API 返回中既无 b64_json 也无 url", detail: JSON.stringify(json).slice(0, 500) },
        { status: 502 }
      );
    }

    /*
     * kind 只表示「调用方应优先用哪个」。实测 Agnes 图片接口默认（不传 response_format）
     * 会同时返回 url 与 b64_json，两者都带上由调用方按需取。
     *
     * 例外：调用方明确要 URL 且确实拿到了 URL 时，**不再回传 b64** ——
     * 关键帧图动辄一两千像素，base64 是 MB 级，回传了也是被丢弃，纯浪费带宽。
     */
    const wantUrl = preferUrl === true;
    if (wantUrl && outUrl) {
      return NextResponse.json({ ok: true, data: { kind: "url", url: outUrl, model: profile.model } });
    }
    const kind = outB64 ? "b64" : "url";

    return NextResponse.json({
      ok: true,
      data: { kind, url: outUrl, data: outB64, model: profile.model },
    });
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
