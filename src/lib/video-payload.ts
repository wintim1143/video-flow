import { shotVideoPrompt } from "./exports";
import type { Shot } from "./schema";
import type { CreateVideoPayload } from "./use-video-tasks";

/**
 * 组装单镜「生成视频」的请求体。
 *
 * 这里是 M1 核心链路的**唯一决策点**，S3 共享端点帧落地后优先级如下：
 *
 * - `first_frame`：**上一镜的收尾帧**（`prevEndKeyframeUrl`）优先 —— 接缝两侧锚定同一张图，
 *   这是跨镜视觉连续性的核心；没有上一镜尾帧时退回本镜自己的关键帧（S0 行为）；
 *   都没有则纯文生视频。
 * - `last_frame`：本镜的收尾帧（`end_keyframe_url`）—— 把本镜终点钉在设计构图上，
 *   同时这张图就是下一镜的 first_frame 来源。两者都给时适配器走「首尾帧控制」。
 *
 * 放在 lib 而不是组件里，是为了能被单测直接覆盖 —— 「帧到底有没有真的传下去」
 * 是这条链路最容易断、也最难靠肉眼发现的地方。
 */
export function buildShotVideoPayload(
  shot: Shot,
  aspectRatio: string | undefined,
  globalNegative: string,
  /** 上一镜的收尾帧 URL（S3）：存在时优先于本镜首帧作 first_frame */
  prevEndKeyframeUrl?: string
): CreateVideoPayload {
  const payload: CreateVideoPayload = {
    prompt: shotVideoPrompt(shot, globalNegative),
    seconds: Math.max(1, Math.round(shot.duration)),
    aspectRatio: aspectRatio || "9:16",
  };
  const firstFrame = prevEndKeyframeUrl || shot.keyframe_url;
  if (firstFrame) payload.firstFrame = firstFrame;
  if (shot.end_keyframe_url) payload.lastFrame = shot.end_keyframe_url;
  return payload;
}
