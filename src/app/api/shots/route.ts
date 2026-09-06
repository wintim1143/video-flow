import { NextResponse } from "next/server";
import { ShotsRequestSchema, StoryboardSchema } from "@/lib/schema";
import { chatJSON, LLMError } from "@/lib/llm";
import { shotsSystemPrompt, shotsUserPrompt, suggestShotCount } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/** S2+S3 分镜生成：brief + 已确认 style → Storyboard（含逐镜 image/video prompt） */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ShotsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }

  const { brief, aspectRatio, targetDuration, style, shotCount, profileId } = parsed.data;
  const count = shotCount ?? suggestShotCount(targetDuration);

  try {
    const { data } = await chatJSON({
      system: shotsSystemPrompt(),
      user: shotsUserPrompt({ brief, aspectRatio, targetDuration, style, shotCount: count }),
      schema: StoryboardSchema,
      temperature: 0.75,
      profileId,
    });
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    if (err instanceof LLMError) {
      const status =
        err.code === "CONFIG_MISSING" ? 400 : err.code === "PARSE" ? 422 : err.code === "TIMEOUT" ? 504 : 502;
      return NextResponse.json({ ok: false, code: err.code, message: err.message, detail: err.detail }, { status });
    }
    return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
  }
}
