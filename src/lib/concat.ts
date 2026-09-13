import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 多镜拼接（M3a）—— 把 N 个分镜成片接成一条片子。
 *
 * 拆成「纯函数 + 执行器」两层，是因为拼接里最容易出错的**不是**跑 ffmpeg，
 * 而是「该用哪种模式」和「参数怎么拼」这两件事：
 *
 *   parseProbe()      ffprobe JSON → 归一化探测结果        （纯，可单测）
 *   planConcat()      探测结果 → 拼接方案                  （纯，决策全在这）
 *   buildConcatArgs() 方案 → ffmpeg 参数                   （纯，可单测）
 *   concatListLine()  concat demuxer 列表行（含转义）       （纯，可单测）
 *   concatShots()     探测 → 定案 → 跑 ffmpeg → 落盘       （I/O）
 *
 * ## 模式为什么这么定（实测依据见 project-docs/20260912_M3方案）
 *
 * | 模式 | 条件 | 理由 |
 * |---|---|---|
 * | `copy` | 各镜视频参数一致 **且都无音轨** | 没有音轨就没有 DTS 问题，全流拷贝最快最无损 |
 * | `video-copy-audio-encode` | 各镜视频参数一致 **且有音轨** | 实测全流拷贝会报 `Non-monotonic DTS`（音频流）；只重编码音轨既能消掉警告，体积还比全流拷贝更小 |
 * | `reencode` | 视频参数不一致 | concat demuxer 要求流参数一致，只能重编码统一 |
 *
 * 注意 `video-copy-audio-encode` 是**默认路径**而不是兜底：Agnes 成片实测都带 AAC 音轨，
 * 而重编码音轨的代价（上游原生 32 kHz → 44.1 kHz/128k）比 70% 的视频重编码代价小得多。
 */

/* ────────────────────────────── 类型 ────────────────────────────── */

export interface ShotProbe {
  /** 分镜序号（用于报错时定位是哪一镜） */
  index: number;
  /** 该镜成片的本地路径 */
  path: string;
  vcodec: string;
  width: number;
  height: number;
  /** 数值帧率（已从 "24/1" 归一化） */
  fps: number;
  /** 像素格式，如 yuv420p */
  pixFmt: string;
  /** 采样宽高比，已归一化（"N/A" → "1:1"） */
  sar: string;
  hasAudio: boolean;
  acodec?: string;
  sampleRate?: number;
  channels?: number;
  durationSec: number;
}

export type ConcatMode = "copy" | "video-copy-audio-encode" | "reencode";

export interface ConcatPlan {
  mode: ConcatMode;
  /** 是否有任何一镜带音轨 —— 决定 ffmpeg 参数里要不要写音频选项 */
  hasAudio: boolean;
  /** 音轨「有无」不一致时，需先给缺轨的镜补静音轨，否则 concat 会错位 */
  audioNormalize: boolean;
  /** 给用户看的一句话解释：为什么选这个模式 */
  reason: string;
  /** 检测到的参数不一致项（重编码时逐条显示，说明为什么没法无损） */
  mismatches: string[];
}

export type ConcatErrorCode =
  | "TOO_FEW_SHOTS"
  | "FFMPEG_MISSING"
  | "PROBE_FAILED"
  | "CONCAT_FAILED"
  | "OUTPUT_MISSING";

export class ConcatError extends Error {
  constructor(
    public code: ConcatErrorCode,
    message: string,
    public detail?: string
  ) {
    super(message);
    this.name = "ConcatError";
  }
}

/* ────────────────────────── 纯函数：归一化 ────────────────────────── */

/** ffprobe 的帧率是 "24/1" 这类分数串；非法值（"0/0"）归 0 */
export function parseFps(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den) return 0;
  // 保留 3 位小数：29.97 / 23.976 这类值必须能区分开，否则会被误判为「参数一致」
  return Math.round((num / den) * 1000) / 1000;
}

/** 采样宽高比归一化：ffprobe 会给 "N/A" / "0:1" 这类占位值，一律视作 1:1 */
export function normalizeSar(v: unknown): string {
  if (typeof v !== "string") return "1:1";
  const s = v.trim();
  if (!s || s === "N/A" || s === "0:1" || s === "0/1") return "1:1";
  return s.replace("/", ":");
}

/**
 * ffprobe `-of json` 输出 → 归一化探测结果。
 *
 * 取 `avg_frame_rate` 优先（VFR 素材上比 `r_frame_rate` 更接近真实播放帧率），
 * 但它是 "0/0" 时退回 `r_frame_rate` —— 短片段上 avg 偶尔确实算不出来。
 */
export function parseProbe(raw: unknown, opts: { index: number; path: string }): ShotProbe {
  const obj = (raw ?? {}) as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(obj.streams) ? (obj.streams as Array<Record<string, unknown>>) : [];
  const format = (obj.format ?? {}) as Record<string, unknown>;

  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) {
    throw new ConcatError(
      "PROBE_FAILED",
      `分镜 #${opts.index} 的成片里没有视频流 —— 文件可能损坏或根本不是 mp4`
    );
  }

  const fps = parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate);
  const durRaw = Number(format.duration ?? video.duration ?? 0);

  return {
    index: opts.index,
    path: opts.path,
    vcodec: String(video.codec_name ?? "?"),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps,
    pixFmt: String(video.pix_fmt ?? "?"),
    sar: normalizeSar(video.sample_aspect_ratio),
    hasAudio: Boolean(audio),
    acodec: audio ? String(audio.codec_name ?? "?") : undefined,
    sampleRate: audio && Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : undefined,
    channels: audio && Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : undefined,
    durationSec: Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 0,
  };
}

/* ────────────────────────── 纯函数：定案 ────────────────────────── */

function videoKey(p: ShotProbe): string {
  return [p.vcodec, `${p.width}x${p.height}`, p.fps, p.pixFmt, p.sar].join("|");
}

function audioKey(p: ShotProbe): string {
  return [p.acodec, p.sampleRate, p.channels].join("|");
}

/**
 * 探测结果 → 拼接方案。
 *
 * 判定顺序刻意是「先看视频能不能无损」：视频参数不一致时，音轨怎么处理都没意义，
 * 只能整体重编码；只有视频一致时才轮到「音轨要不要重编码」这个更划算的选择。
 */
export function planConcat(probes: ShotProbe[]): ConcatPlan {
  if (!probes.length) {
    return {
      mode: "copy",
      hasAudio: false,
      audioNormalize: false,
      reason: "没有输入",
      mismatches: [],
    };
  }

  const first = probes[0];
  const mismatches: string[] = [];

  for (const p of probes.slice(1)) {
    if (p.vcodec !== first.vcodec) {
      mismatches.push(`#${p.index} 视频编码 ${p.vcodec} ≠ #${first.index} ${first.vcodec}`);
    }
    if (p.width !== first.width || p.height !== first.height) {
      mismatches.push(`#${p.index} 尺寸 ${p.width}×${p.height} ≠ #${first.index} ${first.width}×${first.height}`);
    }
    if (p.fps !== first.fps) {
      mismatches.push(`#${p.index} 帧率 ${p.fps} ≠ #${first.index} ${first.fps}`);
    }
    if (p.pixFmt !== first.pixFmt) {
      mismatches.push(`#${p.index} 像素格式 ${p.pixFmt} ≠ #${first.index} ${first.pixFmt}`);
    }
    if (p.sar !== first.sar) {
      mismatches.push(`#${p.index} 采样宽高比 ${p.sar} ≠ #${first.index} ${first.sar}`);
    }
  }

  const hasAudio = probes.some((p) => p.hasAudio);
  const audioCount = probes.filter((p) => p.hasAudio).length;
  const audioMixed = hasAudio && audioCount !== probes.length;

  /* 音轨不全但都相同，仍属「参数一致」；只有流本身不同才算不一致 */
  const audioKeys = new Set(probes.filter((p) => p.hasAudio).map(audioKey));
  const audioNotUniform = audioKeys.size > 1;
  if (!mismatches.length && audioNotUniform) {
    mismatches.push("各镜音轨参数不一致（编码 / 采样率 / 声道数）");
  }

  if (mismatches.length) {
    return {
      mode: "reencode",
      hasAudio,
      audioNormalize: audioMixed,
      reason: `各镜视频参数不一致（${mismatches.length} 处），只能统一重编码 —— 无损拷贝在这里不可用`,
      mismatches,
    };
  }

  if (!hasAudio) {
    return {
      mode: "copy",
      hasAudio: false,
      audioNormalize: false,
      reason: "各镜参数一致，且均无音轨 → 全流拷贝（最快、零损失）",
      mismatches: [],
    };
  }

  return {
    mode: "video-copy-audio-encode",
    hasAudio: true,
    audioNormalize: audioMixed,
    reason: audioMixed
      ? "视频流无损拷贝；音轨有无不一致，缺轨的镜会先补静音轨再统一编码"
      : "视频流无损拷贝 + 音轨重编码 —— 规避拼接处的 DTS 非单调警告，体积反而更小",
    mismatches: [],
  };
}

/* ────────────────────── 纯函数：命令行参数 ────────────────────── */

/** concat demuxer 的列表行；单引号按 ffmpeg 约定转义为 `'\''` */
export function concatListLine(p: string): string {
  return `file '${p.replace(/'/g, "'\\''")}'`;
}

/** 列表文件内容（末尾必带换行，否则最后一行会被 ffmpeg 忽略） */
export function buildListFile(paths: string[]): string {
  return paths.map(concatListLine).join("\n") + "\n";
}

export interface ConcatArgsInput {
  plan: ConcatPlan;
  listPath: string;
  outPath: string;
}

/**
 * 方案 → ffmpeg 参数。
 *
 * `-safe 0` 是必须的：列表里写的是绝对路径，不放开 safe 模式 ffmpeg 会直接拒绝。
 * 音频参数只在有音轨时写 —— 无音轨的输入加 `-c:a` 会变成悬空选项。
 */
export function buildConcatArgs({ plan, listPath, outPath }: ConcatArgsInput): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
  ];

  if (plan.mode === "copy") {
    return [...args, "-c", "copy", outPath];
  }

  if (plan.mode === "video-copy-audio-encode") {
    const audio = plan.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"] : [];
    return [...args, "-c:v", "copy", ...audio, outPath];
  }

  /* reencode：视频参数不一致时的唯一出路 */
  const audio = plan.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"] : [];
  return [
    ...args,
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    ...audio,
    outPath,
  ];
}

/** 给缺音轨的镜生成一条等长静音轨的参数（保持视频流拷贝） */
export function buildSilentAudioArgs(inputPath: string, outPath: string, durationSec: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=44100`,
    "-t",
    durationSec.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    outPath,
  ];
}

/* ────────────────────────── 执行器 ────────────────────────── */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑一个子进程，带超时强杀；ENOENT 由调用方映射成「未安装」 */
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface ConcatInput {
  index: number;
  /** 该镜成片的本地路径 */
  path: string;
}

export interface ConcatResult {
  plan: ConcatPlan;
  probes: ShotProbe[];
  /** 拼接产物绝对路径 */
  outPath: string;
  bytes: number;
  durationSec: number;
  elapsedMs: number;
  /** 逐步日志（已截断），失败时可回给用户排障 */
  log: string[];
}

export interface ConcatOptions {
  inputs: ConcatInput[];
  /** 产物目录（会被创建） */
  outDir: string;
  /** 产物文件名，默认 final.mp4 */
  outName?: string;
  /** 二进制的绝对路径覆盖；默认取 env 或 PATH 里的 ffmpeg/ffprobe */
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function ffmpegBin(override?: string): string {
  return override ?? process.env.FFMPEG_PATH ?? "ffmpeg";
}

function ffprobeBin(override?: string): string {
  return override ?? process.env.FFPROBE_PATH ?? "ffprobe";
}

/** 把子进程错误统一映射：ENOENT 是「没装 ffmpeg」，其余如实抛出 */
function asConcatError(e: unknown, what: string): ConcatError {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    return new ConcatError(
      "FFMPEG_MISSING",
      `未找到 ${what} —— 拼接需要本机安装 ffmpeg（macOS: brew install ffmpeg）`,
      String(e).slice(0, 300)
    );
  }
  return new ConcatError("CONCAT_FAILED", `${what} 执行失败`, String(e).slice(0, 500));
}

/** 探测单个文件 */
export async function probeFile(
  file: { index: number; path: string },
  opts: { ffprobePath?: string; timeoutMs?: number } = {}
): Promise<ShotProbe> {
  const bin = ffprobeBin(opts.ffprobePath);
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    file.path,
  ];
  let res: RunResult;
  try {
    res = await run(bin, args, opts.timeoutMs ?? 60_000);
  } catch (e) {
    throw asConcatError(e, "ffprobe");
  }
  if (res.code !== 0) {
    throw new ConcatError(
      "PROBE_FAILED",
      `无法读取分镜 #${file.index} 的成片（ffprobe 退出码 ${res.code}）`,
      res.stderr.slice(0, 500)
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(res.stdout);
  } catch {
    throw new ConcatError("PROBE_FAILED", `分镜 #${file.index} 的探测输出不是合法 JSON`, res.stdout.slice(0, 300));
  }
  return parseProbe(raw, file);
}

export interface DownloadSpec {
  index: number;
  url: string;
}

/**
 * 把各镜成片拉到本地临时目录。
 *
 * 必须串行：这些 mp4 都在同一个上游域（`platform-outputs.agnes-ai.space`），
 * 并发拉取只会互相挤占带宽，而且首个失败就中止能省掉后面的无用下载。
 */
export async function downloadShots(specs: DownloadSpec[], dir: string): Promise<ConcatInput[]> {
  const out: ConcatInput[] = [];
  for (const s of specs) {
    const target = path.join(dir, `shot-${String(s.index).padStart(2, "0")}.mp4`);
    let res: Response;
    try {
      res = await fetch(s.url, { signal: AbortSignal.timeout(180_000) });
    } catch (e) {
      throw new ConcatError("CONCAT_FAILED", `分镜 #${s.index} 下载失败`, String(e).slice(0, 300));
    }
    if (!res.ok) {
      throw new ConcatError("CONCAT_FAILED", `分镜 #${s.index} 下载失败：上游 HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      throw new ConcatError("CONCAT_FAILED", `分镜 #${s.index} 下载到 0 字节`);
    }
    await writeFile(target, buf);
    out.push({ index: s.index, path: target });
  }
  return out;
}

/**
 * 拼接主流程：探测 → 定案 → （必要时补静音轨）→ 跑 ffmpeg → 校验产物。
 *
 * 临时文件全部放在系统临时目录（`mkdtemp`），**不落项目根** —— 中间产物留在仓库里
 * 既会污染工作树，也容易在后续提交里被误加。
 */
export async function concatShots(opts: ConcatOptions): Promise<ConcatResult> {
  const { inputs, outDir } = opts;
  if (inputs.length < 2) {
    throw new ConcatError("TOO_FEW_SHOTS", `至少需要 2 个分镜才能拼接，当前 ${inputs.length} 个`);
  }

  const startedAt = Date.now();
  const log: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ffmpeg = ffmpegBin(opts.ffmpegPath);

  const probes: ShotProbe[] = [];
  for (const input of inputs) {
    probes.push(await probeFile(input, { ffprobePath: opts.ffprobePath, timeoutMs: 60_000 }));
  }

  const plan = planConcat(probes);
  log.push(`方案 ${plan.mode}：${plan.reason}`);
  for (const m of plan.mismatches) log.push(`  · ${m}`);

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, opts.outName ?? "final.mp4");

  const work = await mkdtemp(path.join(tmpdir(), "video-flow-concat-"));
  try {
    let segmentPaths = inputs.map((i) => i.path);

    /* 音轨有无不一致：先给缺轨的镜补一条等长静音轨，否则 concat 会错位 */
    if (plan.audioNormalize) {
      const fixed: string[] = [];
      for (let i = 0; i < probes.length; i += 1) {
        const p = probes[i];
        if (p.hasAudio) {
          fixed.push(p.path);
          continue;
        }
        const target = path.join(work, `silent-${String(p.index).padStart(2, "0")}.mp4`);
        const args = buildSilentAudioArgs(p.path, target, p.durationSec || 4);
        const res = await runSilent(ffmpeg, args, timeoutMs);
        log.push(`补静音轨 #${p.index} → 退出码 ${res.code}`);
        fixed.push(res.code === 0 ? target : p.path);
      }
      segmentPaths = fixed;
    }

    const listPath = path.join(work, "concat-list.txt");
    await writeFile(listPath, buildListFile(segmentPaths), "utf8");

    const args = buildConcatArgs({ plan, listPath, outPath });
    log.push(`ffmpeg ${args.join(" ")}`);
    const res = await runSilent(ffmpeg, args, timeoutMs);
    if (res.code !== 0) {
      throw new ConcatError(
        "CONCAT_FAILED",
        `ffmpeg 拼接失败（退出码 ${res.code}）`,
        res.stderr.slice(0, 800)
      );
    }
    if (res.stderr.trim()) log.push(`ffmpeg 警告：${res.stderr.trim().slice(0, 400)}`);

    let bytes = 0;
    let durationSec = 0;
    try {
      const st = await stat(outPath);
      bytes = st.size;
      const outProbe = await probeFile({ index: 0, path: outPath }, { ffprobePath: opts.ffprobePath });
      durationSec = outProbe.durationSec;
    } catch {
      /* 产物已生成但读不到元信息：如实留 0，不假装成功 */
    }
    if (!bytes) {
      throw new ConcatError("OUTPUT_MISSING", "拼接命令成功退出，但产物为空或不存在");
    }

    return {
      plan,
      probes,
      outPath,
      bytes,
      durationSec,
      elapsedMs: Date.now() - startedAt,
      log,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** run() 的容错包装：ffmpeg 未安装时同样映射成 FFMPEG_MISSING */
async function runSilent(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    return await run(bin, args, timeoutMs);
  } catch (e) {
    throw asConcatError(e, "ffmpeg");
  }
}
