import { describe, expect, it } from "vitest";
import { dedupeRepeats } from "@/lib/text-utils";

describe("dedupeRepeats（英文 prompt 去重）", () => {
  it("去掉整段完全重复的短语（keywords_en 注入重叠的典型场景）", () => {
    const input =
      "A red lipstick standing upright on a clean ivory background, clean ivory background, soft studio light, a 2.5-second shot.";
    const out = dedupeRepeats(input);
    expect(out.match(/clean ivory background/g)).toHaveLength(1);
    expect(out).toContain("soft studio light");
    expect(out).toContain("a 2.5-second shot.");
  });

  it("忽略大小写与标点（Clean Ivory Background. 视为同一段）", () => {
    const out = dedupeRepeats("clean ivory background, Clean Ivory Background, red lipstick");
    expect(out.match(/ivory/gi)).toHaveLength(1);
    expect(out).toContain("red lipstick");
  });

  it("不做近义合并：不同片段一律保留（避免误伤排比式视觉描述）", () => {
    const input = "soft light, warm tone, soft shadow";
    expect(dedupeRepeats(input)).toBe(input);
  });

  it("分号分隔同样生效", () => {
    expect(dedupeRepeats("velvet matte finish; velvet matte finish; high gloss")).toBe(
      "velvet matte finish; high gloss"
    );
  });

  it("空串 / 无重复时原样返回", () => {
    expect(dedupeRepeats("")).toBe("");
    expect(dedupeRepeats("a red lipstick")).toBe("a red lipstick");
  });

  it("中文分句不误伤（只按半角逗号/分号切）", () => {
    expect(dedupeRepeats("正红色丝绒质地，切面朝向镜头")).toBe("正红色丝绒质地，切面朝向镜头");
  });

  it("压缩多余空白", () => {
    expect(dedupeRepeats("a,   b")).toBe("a, b");
  });
});
