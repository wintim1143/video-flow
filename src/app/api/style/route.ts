import { NextResponse } from "next/server";
import { StyleRequestSchema, StyleSpecSchema } from "@/lib/schema";
import { chatJSON, LLMError } from "@/lib/llm";
import { styleSystemPrompt, styleUserPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/** S1 风格提取/匹配：brief → StyleSpec */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = StyleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }

  const { brief, aspectRatio, targetDuration, profileId } = parsed.data;

  try {
    const { data } = await chatJSON({
      system: styleSystemPrompt(),
      user: styleUserPrompt({ brief, aspectRatio, targetDuration }),
      schema: StyleSpecSchema,
      temperature: 0.8,
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
