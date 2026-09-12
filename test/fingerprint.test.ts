import { describe, expect, it } from "vitest";
import { fingerprint } from "@/lib/fingerprint";

describe("fingerprint", () => {
  it("同输入 → 同指纹（这是 R1.2 判定「结果是否过期」的唯一依据）", () => {
    const a = fingerprint("口红广告", "9:16", 5, 1, "data:image/jpeg;base64,AAA");
    const b = fingerprint("口红广告", "9:16", 5, 1, "data:image/jpeg;base64,AAA");
    expect(a).toBe(b);
  });

  it("任一维变化都会改变指纹", () => {
    const base = fingerprint("口红广告", "9:16", 5, 1, "");
    expect(fingerprint("口红广告改一句", "9:16", 5, 1, "")).not.toBe(base);
    expect(fingerprint("口红广告", "16:9", 5, 1, "")).not.toBe(base);
    expect(fingerprint("口红广告", "9:16", 30, 1, "")).not.toBe(base);
    expect(fingerprint("口红广告", "9:16", 5, 3, "")).not.toBe(base);
    expect(fingerprint("口红广告", "9:16", 5, 1, "data:image/png;base64,BB")).not.toBe(base);
  });

  it("顺序敏感 —— 拼接处用 \\0 分隔，避免「ab + c」与「a + bc」撞车", () => {
    expect(fingerprint("ab", "c")).not.toBe(fingerprint("a", "bc"));
  });

  it("undefined / null 一律视作空串（调用方不必先做归一化）", () => {
    expect(fingerprint("a", undefined, "b")).toBe(fingerprint("a", null, "b"));
    expect(fingerprint("a", undefined, "b")).toBe(fingerprint("a", "", "b"));
  });

  it("输出是 8 位十六进制（可直接当 UI 上的短标识）", () => {
    const fp = fingerprint("x");
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("含多字节中文时不会退化 —— 非 ASCII 也参与散列", () => {
    expect(fingerprint("红色")).not.toBe(fingerprint("蓝色"));
  });
});
