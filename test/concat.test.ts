import { describe, expect, it } from "vitest";
import {
  buildConcatArgs,
  buildListFile,
  concatListLine,
  normalizeSar,
  parseFps,
  parseProbe,
  planConcat,
  type ShotProbe,
} from "@/lib/concat";

/* ─────────────────────────── 归一化 ─────────────────────────── */

describe("parseFps", () => {
  it("分数串 → 数值（保留 3 位小数，区分 29.97 / 23.976）", () => {
    expect(parseFps("24/1")).toBe(24);
    expect(parseFps("30000/1001")).toBe(29.97);
    expect(parseFps("24000/1001")).toBe(23.976);
  });

  it("纯数字串直接转数值", () => {
    expect(parseFps("25")).toBe(25);
  });

  it("非法 / 除零回 0", () => {
    expect(parseFps("0/0")).toBe(0);
    expect(parseFps(undefined)).toBe(0);
    expect(parseFps("abc")).toBe(0);
  });
});

describe("normalizeSar", () => {
  it("占位值一律归 1:1", () => {
    expect(normalizeSar("N/A")).toBe("1:1");
    expect(normalizeSar("0:1")).toBe("1:1");
    expect(normalizeSar("")).toBe("1:1");
  });
  it("斜杠写法归一为冒号", () => {
    expect(normalizeSar("1/1")).toBe("1:1");
  });
  it("真实值原样保留", () => {
    expect(normalizeSar("4:3")).toBe("4:3");
  });
});

describe("parseProbe", () => {
  const base = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 704, height: 1280, avg_frame_rate: "24/1", pix_fmt: "yuv420p", sample_aspect_ratio: "1:1" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "32000", channels: 2 },
    ],
    format: { duration: "4.458333" },
  };

  it("有音轨时 hasAudio=true，时长取 format.duration", () => {
    const p = parseProbe(base, { index: 1, path: "/x/shot-01.mp4" });
    expect(p.hasAudio).toBe(true);
    expect(p.acodec).toBe("aac");
    expect(p.sampleRate).toBe(32000);
    expect(p.fps).toBe(24);
    expect(p.durationSec).toBeCloseTo(4.458, 3);
    expect(p.sar).toBe("1:1");
  });

  it("无音轨时 hasAudio=false", () => {
    const p = parseProbe(
      { streams: [base.streams[0]], format: { duration: "4" } },
      { index: 2, path: "/x/shot-02.mp4" }
    );
    expect(p.hasAudio).toBe(false);
    expect(p.acodec).toBeUndefined();
  });

  it("无视频流直接抛 PROBE_FAILED", () => {
    expect(() =>
      parseProbe({ streams: [{ codec_type: "audio" }], format: {} }, { index: 3, path: "/x/x.mp4" })
    ).toThrow(/没有视频流/);
  });
});

/* ─────────────────────────── 定案 ─────────────────────────── */

function probe(partial: Partial<ShotProbe>): ShotProbe {
  return {
    index: 1,
    path: "/x/a.mp4",
    vcodec: "h264",
    width: 704,
    height: 1280,
    fps: 24,
    pixFmt: "yuv420p",
    sar: "1:1",
    hasAudio: true,
    acodec: "aac",
    sampleRate: 32000,
    channels: 2,
    durationSec: 4,
    ...partial,
  };
}

describe("planConcat", () => {
  it("视频参数一致 + 全有音轨 → video-copy-audio-encode（默认路径）", () => {
    const plan = planConcat([probe({ index: 1 }), probe({ index: 2 })]);
    expect(plan.mode).toBe("video-copy-audio-encode");
    expect(plan.hasAudio).toBe(true);
    expect(plan.audioNormalize).toBe(false);
    expect(plan.mismatches).toEqual([]);
  });

  it("全无音轨 → 纯 copy", () => {
    const plan = planConcat([
      probe({ index: 1, hasAudio: false, acodec: undefined, sampleRate: undefined, channels: undefined }),
      probe({ index: 2, hasAudio: false, acodec: undefined, sampleRate: undefined, channels: undefined }),
    ]);
    expect(plan.mode).toBe("copy");
    expect(plan.hasAudio).toBe(false);
  });

  it("音轨有无混合 → audioNormalize=true（仍走 video-copy-audio-encode）", () => {
    const plan = planConcat([
      probe({ index: 1, hasAudio: true }),
      probe({ index: 2, hasAudio: false, acodec: undefined, sampleRate: undefined, channels: undefined }),
    ]);
    expect(plan.mode).toBe("video-copy-audio-encode");
    expect(plan.audioNormalize).toBe(true);
  });

  it("分辨率不一致 → reencode 并列出 mismatch", () => {
    const plan = planConcat([probe({ index: 1 }), probe({ index: 2, width: 704, height: 1088 })]);
    expect(plan.mode).toBe("reencode");
    expect(plan.mismatches.some((m) => m.includes("尺寸"))).toBe(true);
  });

  it("帧率不一致 → reencode（29.97 不能被误判为一致）", () => {
    const plan = planConcat([probe({ index: 1, fps: 24 }), probe({ index: 2, fps: 29.97 })]);
    expect(plan.mode).toBe("reencode");
    expect(plan.mismatches.some((m) => m.includes("帧率"))).toBe(true);
  });

  it("像素格式不一致 → reencode", () => {
    const plan = planConcat([probe({ index: 1 }), probe({ index: 2, pixFmt: "yuv444p" })]);
    expect(plan.mode).toBe("reencode");
  });
});

/* ─────────────────────────── 参数拼接 ─────────────────────────── */

describe("concatListLine / buildListFile", () => {
  it("单引号按 ffmpeg 约定转义", () => {
    expect(concatListLine("/a/b'c.mp4")).toBe("file '/a/b'\\''c.mp4'");
  });

  it("列表文件末尾必带换行", () => {
    const out = buildListFile(["/a.mp4", "/b.mp4"]);
    expect(out).toBe("file '/a.mp4'\nfile '/b.mp4'\n");
  });
});

describe("buildConcatArgs", () => {
  const plan = planConcat([probe({ index: 1 }), probe({ index: 2 })]);

  it("copy 模式只 -c copy", () => {
    const args = buildConcatArgs({ plan: { ...plan, mode: "copy", hasAudio: false }, listPath: "/l.txt", outPath: "/o.mp4" });
    expect(args).toContain("-safe");
    expect(args).toContain("0");
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args[args.length - 1]).toBe("/o.mp4");
    expect(args).not.toContain("libx264");
  });

  it("video-copy-audio-encode 模式：视频 copy + 音频 aac", () => {
    const args = buildConcatArgs({ plan, listPath: "/l.txt", outPath: "/o.mp4" });
    expect(args).toContain("-c:v");
    expect(args).toContain("copy");
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");
    expect(args).toContain("44100");
    expect(args).not.toContain("libx264");
  });

  it("reencode 模式：libx264 + crf18", () => {
    const args = buildConcatArgs({ plan: { ...plan, mode: "reencode" }, listPath: "/l.txt", outPath: "/o.mp4" });
    expect(args).toContain("libx264");
    expect(args).toContain("18");
    expect(args).toContain("yuv420p");
  });
});
