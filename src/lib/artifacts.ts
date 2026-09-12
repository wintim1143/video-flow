import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 产物归档（R6.1）—— 把「文本交付物 + 需代拉的二进制资产」落到本地目录。
 *
 * 放 lib 而不是 route 里，是因为这里有两处**必须可测**的行为：
 *
 * 1. **单项失败不整体失败**。一条片子有 5 个 mp4，不该因为第 2 个 404 就丢掉其余 4 个。
 * 2. **失败要如实记录**。归档最怕「看起来成功了但少了一半文件」—— 所以 failed 列表
 *    与 written 一样是返回值的一部分，调用方必须能把它呈现给用户。
 *
 * 服务端不认识 storyboard / Shot 这些业务类型：它只会写文本、按 URL 拉二进制。
 * 要多归档一样东西，前端多塞一条即可。
 */

export interface ArchiveFile {
  name: string;
  content: string;
}

export interface ArchiveAsset {
  name: string;
  url: string;
}

export interface ArchiveSpec {
  /** 归档根目录 */
  root: string;
  /** 本次归档的子目录名（见 archiveRunId） */
  runId: string;
  files: ArchiveFile[];
  assets: ArchiveAsset[];
}

export interface ArchiveManifest {
  runId: string;
  at: string;
  dir: string;
  written: Array<{ name: string; bytes: number }>;
  failed: Array<{ name: string; reason: string }>;
  totalBytes: number;
}

/** 目录名用本地时间戳：按归档顺序自然排序，且一眼能对上时间 */
export function archiveRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 单个资产的拉取超时：成片 mp4 可能几十 MB，给足 */
const ASSET_TIMEOUT_MS = 180_000;

export async function archiveArtifacts(spec: ArchiveSpec): Promise<ArchiveManifest> {
  const dir = path.join(spec.root, spec.runId);
  await mkdir(dir, { recursive: true });

  const written: ArchiveManifest["written"] = [];
  const failed: ArchiveManifest["failed"] = [];

  /* 文本：直接落盘。文件名由调用方按 SAFE_NAME 校验过，不存在路径穿越 */
  for (const f of spec.files) {
    try {
      await writeFile(path.join(dir, f.name), f.content, "utf8");
      written.push({ name: f.name, bytes: Buffer.byteLength(f.content, "utf8") });
    } catch (e) {
      failed.push({ name: f.name, reason: String(e).slice(0, 200) });
    }
  }

  /* 资产：服务端代拉（浏览器直下会撞 CORS）。串行，单项失败不影响其余 */
  for (const a of spec.assets) {
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) });
      if (!res.ok) {
        failed.push({ name: a.name, reason: `上游 HTTP ${res.status}` });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(dir, a.name), buf);
      written.push({ name: a.name, bytes: buf.length });
    } catch (e) {
      failed.push({ name: a.name, reason: String(e).slice(0, 200) });
    }
  }

  const manifest: ArchiveManifest = {
    runId: spec.runId,
    at: new Date().toISOString(),
    dir,
    written,
    failed,
    totalBytes: written.reduce((a, f) => a + f.bytes, 0),
  };

  try {
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  } catch {
    /* manifest 写不进去不影响已归档的内容 */
  }

  return manifest;
}
