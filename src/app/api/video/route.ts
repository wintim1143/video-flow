import { NextResponse } from "next/server";
import { z } from "zod";
import { listProfilesSafe } from "@/lib/llm-configs";
import { VideoError, generateVideo } from "@/lib/video";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 视频生成端点（M1 预留接线，**M0 没有 UI 入口**，不会自动产生费用）。
 *
 * GET  /api/video  → 视频 profile 列表（脱敏）+ 是否已配好 mode，用来确认接线状态
 * POST /api/video  → 透传一次视频生成请求
 *   { prompt, imageDataUrl?, mode?, profileId?, extra? }
 *
 * 说明：不同平台的请求体差异大（Agnes Video 必填 mode），因此除 model/prompt/mode 外的
 * 字段一律通过 `extra` 原样透传，不需要为此改代码。
 */
const VideoRequestSchema = z.object({
  prompt: z.string().min(1, "prompt 不能为空"),
  imageDataUrl: z.string().optional(),
  mode: z.string().optional(),
  profileId: z.string().optional(),
  /** 透传字段：duration / resolution / aspect_ratio / seed…（各平台命名不同） */
  extra: z.record(z.unknown()).optional(),
});

export async function GET() {
  const profiles = listProfilesSafe("video");
  return NextResponse.json({
    ok: true,
    count: profiles.length,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      baseURL: p.baseURL,
      endpoint: p.endpoint ?? "/videos",
      /** mode 是各平台的必填项，未配置时调用会得到 MODE_MISSING */
      mode: p.mode ?? null,
      ready: Boolean(p.mode),
    })),
    note: "M1 预留：M0 页面无生视频入口，此端点供脚本 / 后续里程碑调用。",
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = VideoRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }

  const { prompt, imageDataUrl, mode, profileId, extra } = parsed.data;
  try {
    const r = await generateVideo({ prompt, imageUrl: imageDataUrl, mode, extra, profileId });
    return NextResponse.json({ ok: true, mode: r.mode, ms: r.ms, data: r.raw });
  } catch (err) {
    if (err instanceof VideoError) {
      const status =
        err.code === "CONFIG_MISSING" || err.code === "MODE_MISSING"
          ? 400
          : err.status === 429
            ? 429
            : 502;
      return NextResponse.json(
        { ok: false, code: err.code, message: err.message, detail: err.detail },
        { status }
      );
    }
    return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
  }
}
