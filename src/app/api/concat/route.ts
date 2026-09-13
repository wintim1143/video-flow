import { NextResponse } from "next/server";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { archiveRunId } from "@/lib/artifacts";
import { ConcatError, concatShots, downloadShots, type ConcatPlan } from "@/lib/concat";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 多镜拼接端点（M3a）。
 *
 *   POST /api/concat  → 拉取各镜成片 → 拼接 → 落 `<artifactRoot>/<runId>/final.mp4`
 *   GET  /api/concat?runId=xxx[&download=1]  → 回放 / 下载拼接产物（支持 Range）
 *
 * 为什么要服务端拉取而不是让前端传 blob：上游成片 URL 与页面同源策略不同，
 * 且拼接本来就需要文件在服务端；前端只负责把「哪一镜用哪个 URL」报上来。
 *
 * `runId` 可选：若前端已归档过一次，会把那个 runId 传回来，让 `final.mp4`
 * 与同一批交付物落在同一个目录里，而不是散成两个 run。
 */

/** runId 只允许归档目录用的时间戳形态 + 少量安全字符，杜绝路径穿越 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const BodySchema = z.object({
  runId: z.string().regex(RUN_ID, "runId 只允许字母/数字/点/下划线/横线").optional(),
  /** 按分镜顺序给出；服务端按数组顺序拼接 */
  shots: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative(),
        url: z.string().regex(/^https?:\/\//, "分镜成片地址必须是 http(s)"),
      })
    )
    .min(2, "至少需要 2 个分镜才能拼接")
    .max(60),
});

function artifactRoot(): string {
  return process.env.ARTIFACT_DIR ?? path.join(process.cwd(), ".data", "artifacts");
}

/** 把 ConcatError 翻成合适的 HTTP 状态码；ffmpeg 未安装属于环境问题，返回 501 */
function statusOf(err: ConcatError): number {
  switch (err.code) {
    case "TOO_FEW_SHOTS":
      return 400;
    case "FFMPEG_MISSING":
      return 501;
    case "PROBE_FAILED":
      return 422;
    default:
      return 502;
  }
}

function fail(err: unknown) {
  if (err instanceof ConcatError) {
    return NextResponse.json(
      { ok: false, code: err.code, message: err.message, detail: err.detail },
      { status: statusOf(err) }
    );
  }
  return NextResponse.json({ ok: false, code: "UNKNOWN", message: String(err) }, { status: 500 });
}

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

  const { shots } = parsed.data;
  const root = artifactRoot();
  const runId = parsed.data.runId ?? archiveRunId();
  const outDir = path.join(root, runId);

  /* 中间产物放系统临时目录，不污染项目工作树 */
  const work = await mkdtemp(path.join(tmpdir(), "video-flow-concat-src-"));
  try {
    const inputs = await downloadShots(shots, work);

    const result = await concatShots({ inputs, outDir, outName: "final.mp4" });

    /* 拼接收据：与 final.mp4 同目录，便于日后回溯「这条片子是怎么拼出来的」 */
    const sourceTotalSec = result.probes.reduce((a, p) => a + p.durationSec, 0);
    const record = {
      runId,
      at: new Date().toISOString(),
      file: "final.mp4",
      mode: result.plan.mode,
      reason: result.plan.reason,
      mismatches: result.plan.mismatches,
      audioNormalize: result.plan.audioNormalize,
      bytes: result.bytes,
      durationSec: result.durationSec,
      sourceTotalSec,
      elapsedMs: result.elapsedMs,
      sources: shots.map((s) => ({ index: s.index, url: s.url })),
      probes: result.probes.map((p) => ({
        index: p.index,
        vcodec: p.vcodec,
        width: p.width,
        height: p.height,
        fps: p.fps,
        pixFmt: p.pixFmt,
        hasAudio: p.hasAudio,
        durationSec: p.durationSec,
      })),
      log: result.log,
    };
    await writeFile(path.join(outDir, "concat.json"), JSON.stringify(record, null, 2), "utf8");

    const plan: ConcatPlan = result.plan;
    return NextResponse.json({
      ok: true,
      runId,
      dir: outDir,
      relDir: path.relative(process.cwd(), outDir),
      file: "final.mp4",
      /** 回放 / 下载地址（前端直接塞给 <video src> 或 <a download>） */
      url: `/api/concat?runId=${encodeURIComponent(runId)}`,
      plan,
      bytes: result.bytes,
      durationSec: result.durationSec,
      /** 各镜时长之和：与 durationSec 的差值即拼接容差（实测 ~0.03s 量级） */
      sourceTotalSec,
      elapsedMs: result.elapsedMs,
      probes: record.probes,
    });
  } catch (err) {
    return fail(err);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const runId = sp.get("runId")?.trim() ?? "";
  const download = sp.get("download") === "1";

  if (!RUN_ID.test(runId)) {
    return NextResponse.json({ ok: false, code: "BAD_INPUT", message: "runId 不合法" }, { status: 400 });
  }

  const root = path.resolve(artifactRoot());
  const file = path.resolve(root, runId, "final.mp4");
  /* 双保险：正则已挡住穿越，这里再确认解析后的路径确实落在归档根目录内 */
  if (file !== path.join(root, runId, "final.mp4") || !file.startsWith(root + path.sep)) {
    return NextResponse.json({ ok: false, code: "BAD_INPUT", message: "路径越界" }, { status: 400 });
  }

  let size: number;
  let buf: Buffer;
  try {
    const st = await stat(file);
    size = st.size;
    buf = await readFile(file);
  } catch {
    return NextResponse.json(
      { ok: false, code: "NOT_FOUND", message: "该 runId 下还没有拼接产物，请先执行拼接" },
      { status: 404 }
    );
  }

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="final.mp4"`,
  });

  /*
   * Range 支持不是可选项：`<video>` 拖动进度条会发 Range 请求，
   * 不支持时浏览器只能整段下载再播，长片子体验很差。
   */
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    /* "bytes=-500" 是「最后 500 字节」的写法 */
    if (!m[1] && m[2]) {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
      end = Math.min(end, size - 1);
      const chunk = buf.subarray(start, end + 1);
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(chunk.length));
      return new Response(new Uint8Array(chunk), { status: 206, headers });
    }
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  headers.set("Content-Length", String(size));
  return new Response(new Uint8Array(buf), { status: 200, headers });
}
