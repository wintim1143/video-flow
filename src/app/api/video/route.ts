import { NextResponse } from "next/server";
import { z } from "zod";
import { listProfilesSafe } from "@/lib/llm-configs";
import {
  VideoError,
  createVideoTask,
  listProviders,
  queryVideoTask,
  resolveVideoProvider,
  videoGateSnapshot,
} from "@/lib/video";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 视频生成端点（异步任务形态：POST 建任务 → GET 轮询）。
 *
 *   GET  /api/video                  → 能力自述：video profiles（脱敏）+ 可用适配器 + 限流闸门快照
 *   GET  /api/video?taskId=xxx       → 查询任务状态；completed 时返回 videoUrl
 *   POST /api/video                  → 建任务，返回 taskId（用 GET 轮询）
 *
 * 限流分两类，**量级完全不同**（详见 `video-rate-limit.ts`）：
 *   - 建任务吃生成配额（免费档 1 次/分钟）→ 没到点回 429 `THROTTLED` + `retryAfterMs`
 *   - 查询宽松得多：上游实测 3s 间隔可长期稳定，2s 会周期性回 429（带 `Retry-After`）
 *
 * 成功响应里 `nextCreateAfterMs` / `nextQueryAfterMs` 分别告诉前端「下次能建任务」
 * 和「下次能查询」各要等多久 —— 这是两个不同的数，不要混用。
 */

const CreateRequestSchema = z.object({
  prompt: z.string().min(1, "prompt 不能为空"),
  /** 语义化入参：适配器负责转成上游要的类型（Agnes 要字符串 "4"–"12"） */
  seconds: z.coerce.number().positive().max(120).optional(),
  aspectRatio: z.string().optional(),
  size: z.string().optional(),
  mode: z.string().optional(),
  firstFrame: z.string().optional(),
  lastFrame: z.string().optional(),
  images: z.array(z.string()).optional(),
  audios: z.array(z.string()).optional(),
  seed: z.coerce.number().int().optional(),
  profileId: z.string().optional(),
  /** 平台特有的额外字段，原样透传（不覆盖 model / prompt / mode） */
  extra: z.record(z.unknown()).optional(),
});

/** VideoError → HTTP 状态码 */
function statusOf(err: VideoError): number {
  switch (err.code) {
    case "CONFIG_MISSING":
    case "UNKNOWN_PROVIDER":
    case "MODE_MISSING":
    case "BAD_REQUEST":
      return 400;
    case "THROTTLED":
      return 429;
    default:
      return err.status === 429 ? 429 : 502;
  }
}

function fail(err: unknown) {
  if (err instanceof VideoError) {
    return NextResponse.json(
      {
        ok: false,
        code: err.code,
        message: err.message,
        detail: err.detail,
        retryAfterMs: err.retryAfterMs,
      },
      { status: statusOf(err) }
    );
  }
  return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
}

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get("taskId")?.trim();
  const profileId = new URL(req.url).searchParams.get("profileId")?.trim() || undefined;

  /* ── 查询任务 ── */
  if (taskId) {
    try {
      const r = await queryVideoTask({ taskId, profileId });
      const gate = videoGateSnapshot();
      return NextResponse.json({
        ok: true,
        taskId,
        status: r.status,
        progress: r.progress,
        videoUrl: r.videoUrl,
        error: r.error,
        ms: r.ms,
        /* 前端下一次轮询的等待时间（查询闸门通常为 0，即可以立刻再查） */
        nextQueryAfterMs: gate.query.retryAfterMs,
      });
    } catch (err) {
      return fail(err);
    }
  }

  /* ── 能力自述（无 taskId） ── */
  const profiles = listProfilesSafe("video");
  return NextResponse.json({
    ok: true,
    count: profiles.length,
    profiles: profiles.map((p) => {
      let providerId = "?";
      try {
        providerId = resolveVideoProvider(p).id;
      } catch {
        providerId = "未知（provider 字段配置有误）";
      }
      return {
        id: p.id,
        name: p.name,
        model: p.model,
        baseURL: p.baseURL,
        /** 命中的适配器；决定走哪套建任务/查询协议 */
        provider: providerId,
        /** 留空即由适配器按媒体字段推断模式 */
        mode: p.mode ?? null,
      };
    }),
    providers: listProviders(),
    gate: videoGateSnapshot(),
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = CreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_INPUT", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }

  try {
    const r = await createVideoTask(parsed.data);
    const gate = videoGateSnapshot();
    return NextResponse.json({
      ok: true,
      taskId: r.taskId,
      upstreamId: r.upstreamId,
      status: r.status,
      progress: r.progress,
      provider: r.provider,
      mode: r.mode,
      ms: r.ms,
      data: r.raw,
      /* 生成配额已消耗 → 多久之后才能再建任务（前端据此禁用所有「生成视频」按钮） */
      nextCreateAfterMs: gate.create.retryAfterMs,
      /* 与之无关：多久之后可以查询。通常立即 */
      nextQueryAfterMs: gate.query.retryAfterMs,
    });
  } catch (err) {
    return fail(err);
  }
}
