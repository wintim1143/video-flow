import { NextResponse } from "next/server";
import { StyleRequestSchema, StyleSpecSchema } from "@/lib/schema";
import { chatJSON, LLMError } from "@/lib/llm";
import { styleSystemPrompt, styleUserPrompt, styleFromImageSystemPrompt, styleFromImageUserPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/** S1 风格提取/匹配：brief（文字）或参考图 → StyleSpec；两者可同时给（图定风格、文定内容） */
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

  const { brief, aspectRatio, targetDuration, profileId, imageDataUrl } = parsed.data;

  /* brief 与图至少一项（纯图提取时 brief 可为空） */
  if (!brief.trim() && !imageDataUrl) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: "请填写广告描述，或上传一张参考图" },
      { status: 400 }
    );
  }

  try {
    const fromImage = !!imageDataUrl;
    const { data } = await chatJSON({
      system: fromImage ? styleFromImageSystemPrompt() : styleSystemPrompt(),
      user: fromImage
        ? styleFromImageUserPrompt({ brief })
        : styleUserPrompt({ brief: brief.trim() || "（无文字描述，以参考图为准）", aspectRatio, targetDuration }),
      schema: StyleSpecSchema,
      temperature: 0.8,
      profileId,
      imageUrl: imageDataUrl,
    });
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    if (err instanceof LLMError) {
      /* 带图请求被 400 拒 → 大概率所选模型不支持视觉输入，给出可操作的提示 */
      const visionRejected =
        !!imageDataUrl && err.code === "UPSTREAM" && /image|vision|multimodal|content.*type/i.test(`${err.message} ${err.detail ?? ""}`);
      if (visionRejected) {
        return NextResponse.json(
          {
            ok: false,
            code: "VISION_UNSUPPORTED",
            message: "当前文本 LLM 不支持图片输入。请在顶栏切换到支持视觉的模型（或在 llm.config.json 配一个多模态模型），或改用纯文字描述。",
            detail: err.detail,
          },
          { status: 400 }
        );
      }
      const status =
        err.code === "CONFIG_MISSING" ? 400 : err.code === "PARSE" ? 422 : err.code === "TIMEOUT" ? 504 : 502;
      return NextResponse.json({ ok: false, code: err.code, message: err.message, detail: err.detail }, { status });
    }
    return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
  }
}
