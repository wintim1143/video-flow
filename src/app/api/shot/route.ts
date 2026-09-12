import { NextResponse } from "next/server";
import { SingleShotRequestSchema, ShotSchema, type Shot } from "@/lib/schema";
import { chatJSON, LLMError } from "@/lib/llm";
import { newTraceId } from "@/lib/trace-log";
import { dedupeRepeats } from "@/lib/text-utils";
import { shotDetailSystemPrompt, shotDetailUserPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 单镜重生成（非流式；单镜输出小，10-40s 可完成）。
 * 用于分镜流式生成中失败镜头的定点重试，不必整单重来。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = SingleShotRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const { brief, aspectRatio, targetDuration, style, outline, index, neighbors, profileId } = parsed.data;

  try {
    const started = performance.now();
    const { data, usage } = await chatJSON({
      system: shotDetailSystemPrompt(),
      user: shotDetailUserPrompt({ brief, style, outline, index, neighbors }),
      schema: ShotSchema,
      temperature: 0.7,
      profileId,
      trace: { traceId: newTraceId(), step: `shot_retry:${index}` },
    });
    /* start 时间轴以邻居为准重算（服务端兜底，不信 LLM 算术） */
    const prev = neighbors.filter((n) => n.index === index - 1)[0];
    const next = neighbors.filter((n) => n.index === index + 1)[0];
    let start = data.start;
    if (prev) start = prev.start + (prev.duration || 5);
    else if (next) start = Math.max(0, next.start - (data.duration || 5));
    const fixed: Shot = ShotSchema.parse({
      ...data,
      index,
      start,
      duration: data.duration || outline.outline.find((o) => o.index === index)?.duration || 5,
      /* 状态链服务端强制覆盖为大纲值（连续性锚点，不依赖 LLM 照抄） */
      start_state: outline.outline.find((o) => o.index === index)?.start_state || data.start_state,
      end_state: outline.outline.find((o) => o.index === index)?.end_state || data.end_state,
      /* 转场设计同样以大纲为准 */
      transition_out: outline.outline.find((o) => o.index === index)?.transition_out || data.transition_out,
      /* keywords_en verbatim 注入常与场景描述重叠 → 去掉整段重复 */
      image_prompt: dedupeRepeats(data.image_prompt),
      video_prompt: dedupeRepeats(data.video_prompt),
    });
    return NextResponse.json({
      ok: true,
      data: fixed,
      meta: {
        ms: Math.round(performance.now() - started),
        aspectRatio,
        targetDuration,
        usage,
      },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      const status =
        err.code === "CONFIG_MISSING" ? 400 : err.code === "PARSE" ? 422 : err.code === "TIMEOUT" ? 504 : 502;
      return NextResponse.json({ ok: false, code: err.code, message: err.message, detail: err.detail }, { status });
    }
    return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
  }
}
