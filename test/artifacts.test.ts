import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveArtifacts, archiveRunId } from "@/lib/artifacts";

/**
 * 归档的可测契约（R6.1）：
 *   1. 文本与资产都要真的落盘
 *   2. **单项失败不整体失败** —— 5 个 mp4 里挂 1 个，其余 4 个必须还在
 *   3. 失败要如实进 failed 列表，不能静默吞掉（「看起来成功了但少了文件」是归档最坏的结果）
 */

let root = "";

beforeEach(async () => {
  /* fixture 一律落 /tmp，不碰项目目录 */
  root = await mkdtemp(path.join(tmpdir(), "vf-artifacts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 按 url 分派响应的 fetch stub */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
}

describe("archiveRunId", () => {
  it("形如 YYYYMMDD-HHMMSS —— 排序即时间序", () => {
    const id = archiveRunId(new Date(2026, 8, 12, 19, 5, 7));
    expect(id).toBe("20260912-190507");
  });

  it("月日时分秒都补零", () => {
    expect(archiveRunId(new Date(2026, 0, 1, 0, 0, 0))).toBe("20260101-000000");
  });
});

describe("archiveArtifacts", () => {
  it("文本交付物落盘，并写出一份 manifest", async () => {
    const m = await archiveArtifacts({
      root,
      runId: "run-1",
      files: [
        { name: "storyboard.json", content: '{"a":1}' },
        { name: "storyboard.md", content: "# 分镜" },
      ],
      assets: [],
    });

    expect(m.written.map((f) => f.name).sort()).toEqual(["storyboard.json", "storyboard.md"]);
    expect(m.failed).toEqual([]);
    expect(m.totalBytes).toBe(Buffer.byteLength('{"a":1}') + Buffer.byteLength("# 分镜", "utf8"));

    const onDisk = await readFile(path.join(root, "run-1", "storyboard.md"), "utf8");
    expect(onDisk).toBe("# 分镜");

    const manifest = JSON.parse(await readFile(path.join(root, "run-1", "manifest.json"), "utf8"));
    expect(manifest.runId).toBe("run-1");
    expect(manifest.written).toHaveLength(2);
  });

  it("资产由服务端代拉并按字节落盘", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 }))
    );

    const m = await archiveArtifacts({
      root,
      runId: "run-2",
      files: [],
      assets: [{ name: "shot-01.mp4", url: "https://cdn.example/shot-01.mp4" }],
    });

    expect(m.failed).toEqual([]);
    expect(m.written).toEqual([{ name: "shot-01.mp4", bytes: 3 }]);
    const buf = await readFile(path.join(root, "run-2", "shot-01.mp4"));
    expect([...buf]).toEqual([0, 1, 2]);
  });

  it("单个资产 404 不影响其余 —— 5 个成片里挂 1 个，剩下 4 个必须还在", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch((url) =>
        url.endsWith("shot-02.mp4")
          ? new Response("gone", { status: 404 })
          : new Response(new Uint8Array([1]), { status: 200 })
      )
    );

    const m = await archiveArtifacts({
      root,
      runId: "run-3",
      files: [],
      assets: [1, 2, 3, 4, 5].map((i) => ({
        name: `shot-0${i}.mp4`,
        url: `https://cdn.example/shot-0${i}.mp4`,
      })),
    });

    expect(m.written.map((f) => f.name)).toEqual(["shot-01.mp4", "shot-03.mp4", "shot-04.mp4", "shot-05.mp4"]);
    expect(m.failed).toEqual([{ name: "shot-02.mp4", reason: "上游 HTTP 404" }]);
    /* 落盘的确实是 4 个，不是 5 个 */
    await expect(stat(path.join(root, "run-3", "shot-02.mp4"))).rejects.toThrow();
  });

  it("网络层异常也进 failed，不抛出（归档不该因为一个 URL 炸掉整批）", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => {
        throw new Error("ECONNRESET");
      })
    );

    const m = await archiveArtifacts({
      root,
      runId: "run-4",
      files: [{ name: "storyboard.json", content: "{}" }],
      assets: [{ name: "shot-01.mp4", url: "https://cdn.example/x.mp4" }],
    });

    expect(m.written.map((f) => f.name)).toEqual(["storyboard.json"]);
    expect(m.failed).toHaveLength(1);
    expect(m.failed[0].name).toBe("shot-01.mp4");
    expect(m.failed[0].reason).toContain("ECONNRESET");
  });

  it("totalBytes 只统计写成功的文件（失败的不计入，否则用户会以为东西齐了）", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch((url) =>
        url.endsWith("bad.bin")
          ? new Response("nope", { status: 500 })
          : new Response(new Uint8Array([1, 2]), { status: 200 })
      )
    );
    const m = await archiveArtifacts({
      root,
      runId: "run-5",
      files: [{ name: "a.txt", content: "12345" }],
      assets: [
        { name: "ok.bin", url: "https://cdn.example/ok.bin" },
        { name: "bad.bin", url: "https://cdn.example/bad.bin" },
      ],
    });
    expect(m.failed.map((f) => f.name)).toEqual(["bad.bin"]);
    /* 文本 5 + 成功资产 2；失败的那个不计 */
    expect(m.totalBytes).toBe(7);
  });
});
