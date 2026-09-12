/**
 * 提示词文本后处理小工具（纯函数，无依赖）。
 */

/** 归一化用于比较：小写、去标点、压缩空白 */
function normSeg(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 去掉英文 prompt 里**整段重复**的冗余片段。
 *
 * 背景：跨镜一致性要求把风格 keywords_en 逐字拼进每镜 prompt，当同一短语
 * 已经出现在场景描述里时（如 "clean ivory background"），生成的 prompt 会出现两次。
 *
 * 策略：按 `, ` / `; ` 切段，丢弃满足任一条件的段 ——
 *   ① 与前面某段归一化后**完全相同**；
 *   ② 归一化后作为**完整词组**已被前面已保留的文本包含（处理"短语嵌在长句里"的重复）。
 * 只做字面比对、不做近义合并，因此不会误伤正常的排比式视觉描述
 * （"soft light, warm tone, soft shadow" 这类不同段一律保留）。
 */
export function dedupeRepeats(text: string): string {
  if (!text) return text;
  const segments = text.split(/(?<=[,;])\s+/);
  const emitted: string[] = [];
  const out: string[] = [];
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    const key = normSeg(seg);
    if (key) {
      // ① 完全相同
      if (emitted.includes(key)) continue;
      // ② 作为完整词组已被前面保留的文本包含
      if (` ${emitted.join(" ")} `.includes(` ${key} `)) continue;
      emitted.push(key);
    }
    out.push(seg);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
