/**
 * 输入指纹 —— 用来回答「当前这份结果，对应的是哪一次输入」。
 *
 * 为什么需要它（R1.2 同输入幂等去重的落点）：
 *
 * 最贵的错误不是「同输入跑了两次」，而是**改了输入却拿旧结果继续往下走**。
 * 用户改完 brief 忘了重新生成分镜，接着一路生关键帧、生视频 —— 每一步都真烧配额，
 * 而产物是旧输入的分镜。这个错误没有任何 UI 信号，肉眼也看不出来。
 *
 * 所以这里不做「静默拦截重复提交」（那是反直觉的：点按钮就是要重跑），
 * 而是让**结果 ↔ 输入的对应关系可见**：指纹一致说明结果是最新的，不一致就明确警告。
 *
 * 不用于任何安全用途 —— FNV-1a 32 位，只做相等比较。
 */
export function fingerprint(...parts: Array<string | number | undefined | null>): string {
  const joined = parts.map((p) => (p === undefined || p === null ? "" : String(p))).join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
