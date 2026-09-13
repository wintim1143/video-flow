import { NextResponse } from "next/server";
import path from "node:path";
import { z } from "zod";
import { archiveArtifacts, archiveRunId } from "@/lib/artifacts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 产物归档（R6.1「交付 = 成片文件 + 预览 URL + 关键帧 + 风格 JSON」）。
 *
 * 归档之前的缺口：成片只活在上游 URL 上，工作台的任务记录一「清除」就再也找不回来 ——
 * 预览 URL 不等于交付物。这里把成片 mp4 与关键帧图**真正落到本地磁盘**。
 *
 * 本路由只做三件事：校验入参 → 调 `lib/artifacts.ts` 落盘 → 把清单回给前端。
 * 真正的落盘逻辑（含「单项失败不整体失败」）在 lib 里，可单测。
 *
 * 不用 zip 而用目录：Node 无内置 zip 写入，引 archiver/jszip 纯为打包加一层依赖；
 * 而这是**本地 Web 工具**，产物直接落在工作目录下反而更好取用。
 */

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const BodySchema = z.object({
  /** 文本类交付物：内容由前端算好（复用 exports.ts），服务端只负责落盘 */
  files: z
    .array(
      z.object({
        name: z.string().regex(SAFE_NAME, "文件名只允许字母/数字/点/下划线/横线"),
        content: z.string().max(5_000_000),
      })
    )
    .max(20)
    .default([]),
  /** 二进制资产：成片 mp4、关键帧图等，由服务端代拉（浏览器直下会撞 CORS） */
  assets: z
    .array(
      z.object({
        name: z.string().regex(SAFE_NAME, "文件名只允许字母/数字/点/下划线/横线"),
        url: z.string().regex(/^https?:\/\//, "只接受 http(s) 地址"),
      })
    )
    .max(60)
    .default([]),
  /** 指定归档子目录名（M3a 拼接会把产物先落到某个 runId，归档时复用同一目录） */
  runId: z.string().regex(SAFE_NAME, "runId 只允许字母/数字/点/下划线/横线").optional(),
});

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
  const { files, assets, runId } = parsed.data;
  if (!files.length && !assets.length) {
    return NextResponse.json({ ok: false, code: "BAD_INPUT", message: "没有要归档的内容" }, { status: 400 });
  }

  const root = process.env.ARTIFACT_DIR ?? path.join(process.cwd(), ".data", "artifacts");

  try {
    const manifest = await archiveArtifacts({ root, runId: runId ?? archiveRunId(), files, assets });
    return NextResponse.json({
      ok: true,
      ...manifest,
      /** 相对项目根的路径：便于在终端 / README 里引用 */
      relDir: path.relative(process.cwd(), manifest.dir),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FS", message: `无法创建归档目录（${root}）`, detail: String(e).slice(0, 400) },
      { status: 500 }
    );
  }
}
