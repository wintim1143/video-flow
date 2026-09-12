import { ShotsRequestSchema, OutlineSchema, ShotSchema, type Shot } from "@/lib/schema";
import { chatJSON, LLMError } from "@/lib/llm";
import { newTraceId } from "@/lib/trace-log";
import { dedupeRepeats } from "@/lib/text-utils";
import {
  outlineSystemPrompt,
  outlineUserPrompt,
  shotDetailSystemPrompt,
  shotDetailUserPrompt,
  suggestShotCount,
} from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * 两段式分镜生成（SSE 流式）：
 *   step1 大纲（小输出，快） → step2 逐镜展开（单镜小输出，失败只重试单镜）。
 * 事件流（data: JSON\n\n）：
 *   { type: "trace",  step, message, ms?, usage? }   每步开始/结束的链路追踪
 *   { type: "outline", outline }                     大纲就绪
 *   { type: "shot",   shot, ms, usage }              单镜完成（实时插入前端时间轴）
 *   { type: "shot_error", index, message }           单镜重试后仍失败（其余镜继续）
 *   { type: "done",   failedIndexes, traces }        全部结束
 *   { type: "error",  code, message, detail? }       整体失败（如未配置 LLM / 大纲失败）
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ShotsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const { brief, aspectRatio, targetDuration, style, shotCount, profileId } = parsed.data;
  const count = shotCount ?? suggestShotCount(targetDuration);
  const traceId = newTraceId(); // 一次分镜生成 = 一条链路（大纲 + 各镜共用）

  const encoder = new TextEncoder();
  const traces: Array<{ step: string; message: string; ms: number; usage?: unknown }> = [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const t0 = performance.now();
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const trace = (step: string, message: string, extra?: { ms?: number; usage?: unknown }) => {
        const t = { step, message, ms: extra?.ms ?? Math.round(performance.now() - t0), usage: extra?.usage };
        if (extra?.ms !== undefined) traces.push({ step, message, ms: extra.ms, usage: extra.usage });
        send({ type: "trace", ...t });
      };

      try {
        /* ── step 1：大纲 ── */
        trace("outline", "正在生成分镜大纲…");
        const s1 = performance.now();
        const { data: outline, usage: u1 } = await chatJSON({
          system: outlineSystemPrompt(),
          user: outlineUserPrompt({ brief, aspectRatio, targetDuration, shotCount: count }),
          schema: OutlineSchema,
          temperature: 0.6,
          profileId,
          trace: { traceId, step: "outline" },
        });
        const ms1 = Math.round(performance.now() - s1);
        trace("outline_done", `大纲完成：${outline.outline.length} 镜 · ${(ms1 / 1000).toFixed(1)}s`, {
          ms: ms1,
          usage: u1,
        });
        send({ type: "outline", outline });

        /* start 时间轴按 duration 累加（不让 LLM 算，避免算术错） */
        const starts = new Map<number, number>();
        let acc = 0;
        for (const o of outline.outline) {
          starts.set(o.index, acc);
          acc += o.duration;
        }

        /* ── step 2：逐镜展开（串行流水线，尾帧链）──
         * 串行的原因（参考 ai-video-pipeline / StoryMem 的尾帧链模式）：
         * 每镜生成后，其成品（image_prompt / end_state）会作为 neighbors 喂给下一镜，
         * 实现「镜 N 末帧 = 镜 N+1 首帧」的动势衔接；并发会丢失这种接力。
         * 单镜失败自动重试 1 次，仍失败跳过并上报。 */
        const shots: Shot[] = [];
        const failed: number[] = [];
        const CONCURRENCY = 1; // 串行：下一镜依赖上一镜成品做尾帧衔接
        let cursor = 0;

        async function genOneShot(item: (typeof outline.outline)[number]): Promise<void> {
          const s = performance.now();
          let shot: Shot | null = null;
          let lastErr = "";
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              if (attempt === 2) trace(`shot_${item.index}`, `第 ${item.index} 镜首次失败，重试中…`);
              const { data } = await chatJSON({
                system: shotDetailSystemPrompt(),
                user: shotDetailUserPrompt({
                  brief,
                  style,
                  outline,
                  index: item.index,
                  neighbors: shots.filter((n) => Math.abs(n.index - item.index) === 1),
                }),
                schema: ShotSchema,
                temperature: 0.7,
                profileId,
                trace: { traceId, step: `shot_${item.index}` },
              });
              shot = data;
              break;
            } catch (err) {
              lastErr = err instanceof LLMError ? err.message : String(err);
            }
          }
          const ms = Math.round(performance.now() - s);
          if (!shot) {
            failed.push(item.index);
            trace(`shot_${item.index}_fail`, `第 ${item.index} 镜生成失败：${lastErr}`, { ms });
            send({ type: "shot_error", index: item.index, message: lastErr });
            return;
          }
          /* 服务端兜底填 index/start/duration（大纲为准，不信 LLM 的算术） */
          const fixed: Shot = {
            ...shot,
            index: item.index,
            start: starts.get(item.index) ?? shot.start,
            duration: shot.duration || item.duration,
            /* 状态链服务端强制覆盖为大纲值（连续性的锚，不依赖 LLM 照抄） */
            start_state: item.start_state || shot.start_state,
            end_state: item.end_state || shot.end_state,
            /* 转场设计同样以大纲为准（大纲阶段统一规划，防止逐镜自由发挥导致生硬跳切） */
            transition_out: item.transition_out || shot.transition_out,
            /* keywords_en verbatim 注入常与场景描述重叠 → 去掉整段重复 */
            image_prompt: dedupeRepeats(shot.image_prompt),
            video_prompt: dedupeRepeats(shot.video_prompt),
          };
          const validated = ShotSchema.parse(fixed);
          shots.push(validated);
          shots.sort((a, b) => a.index - b.index);
          trace(`shot_${item.index}_done`, `第 ${item.index} 镜完成 · ${(ms / 1000).toFixed(1)}s`, { ms });
          send({ type: "shot", shot: validated, ms });
        }

        async function worker(): Promise<void> {
          while (cursor < outline.outline.length) {
            const item = outline.outline[cursor++];
            await genOneShot(item);
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, outline.outline.length) }, () => worker()));

        trace("all_done", `分镜全部结束：成功 ${shots.length} 镜${failed.length ? `，失败 ${failed.length} 镜` : ""}`);
        send({ type: "done", failedIndexes: failed, traces });

        /* 全部失败时才整体报错语义（前端据此给重试入口） */
        if (!shots.length) {
          send({ type: "error", code: "ALL_SHOTS_FAILED", message: "所有分镜均生成失败，请重试或更换文本 LLM" });
        }
      } catch (err) {
        if (err instanceof LLMError) {
          send({ type: "error", code: err.code, message: err.message, detail: err.detail });
        } else {
          send({ type: "error", code: "UNKNOWN", message: String(err) });
        }
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
