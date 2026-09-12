import { shotVideoPrompt } from "./exports";
import type { Shot } from "./schema";
import type { CreateVideoPayload } from "./use-video-tasks";

/**
 * 组装单镜「生成视频」的请求体。
 *
 * 这里是 M1 核心链路的**唯一决策点**：有关键帧就把它的 URL 作为 `firstFrame` 传下去，
 * 适配器据此推断成 `keyframe` 模式（`first_frame` 字段），也就是图生视频；
 * 没有则退化为纯文生视频。
 *
 * 放在 lib 而不是组件里，是为了能被单测直接覆盖 —— 「首帧到底有没有真的传下去」
 * 是这条链路最容易断、也最难靠肉眼发现的地方。
 */
export function buildShotVideoPayload(
  shot: Shot,
  aspectRatio: string | undefined,
  globalNegative: string
): CreateVideoPayload {
  const payload: CreateVideoPayload = {
    prompt: shotVideoPrompt(shot, globalNegative),
    seconds: Math.max(1, Math.round(shot.duration)),
    aspectRatio: aspectRatio || "9:16",
  };
  if (shot.keyframe_url) payload.firstFrame = shot.keyframe_url;
  return payload;
}
