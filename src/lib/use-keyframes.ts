"use client";

import { useCallback, useRef, useState } from "react";
import type { Shot } from "@/lib/schema";

/**
 * 关键帧生成（M1 闸门 2 —— 「先生关键帧，再图生视频」）。
 *
 * 为什么值得单独一个 hook：
 *
 * 1. **串行队列**。图接口同样有并发限制，一次点 5 镜并行生成大概率被 429。
 *    这里把所有请求串成一条链，逐个发（与分镜展开的 CONCURRENCY=1 同一思路）。
 * 2. **强制 URL 校验**。I2V 的首帧必须是上游能自己拉取的公网图片地址；
 *    若图片服务只回 base64，这里直接给出可读错误，而不是把一个没法用的串塞进 Shot。
 * 3. 每个分镜独立的 busy / error，互不干扰。
 */

export interface KeyframeRequest {
  prompt: string;
  profileId?: string;
  size?: string;
}

export interface KeyframeBatchItem {
  index: number;
  req: KeyframeRequest;
}

/**
 * 按画幅选生图尺寸 —— **直接用视频输出画布的同款比例**。
 *
 * 为什么不用图片接口的三个常规预设：**keyframe 模式下，成片的画幅由首帧图决定**，
 * `aspect_ratio` 会被弱化。实测请求 9:16 却用 1024×1536（2:3）当首帧，
 * 出片是 704×1088 —— 既不是 9:16，也不是 2:3。首帧比例与目标画幅对齐后才是可控的。
 */
export function keyframeSizeFor(aspectRatio: string | undefined): string {
  if (aspectRatio === "9:16") return "720x1280";
  if (aspectRatio === "16:9") return "1280x720";
  return "720x720";
}

/**
 * 单镜关键帧的发起次数上限 —— 对应验收判据 R3.2「闸门 2 确认/重出 ≤2 次」：
 * 首次 1 次 + 最多 2 次重出 = 3。
 *
 * 超限后 `KeyframeBar` 会锁住「重新生成」，需要点「解除限制」显式解禁才能继续。
 * 这是**软约束**：本地工具里硬锁死会挡住正当的反复打磨，但默认状态必须守住判据，
 * 否则「闸门 2 人工把关防乱烧」这条设计意图就形同虚设。
 */
export const MAX_KEYFRAME_ATTEMPTS = 3;

/**
 * S3 共享端点帧：本镜**收尾帧**的生图 prompt。
 *
 * 收尾画面的权威描述是 `end_state`（大纲层硬性要求镜 N+1 承接它）；场景/主体/画风
 * 的视觉语言借本镜 image_prompt 保持同一基调。全中文组合 —— Agnes 生图是中文产品，
 * 且 end_state 本身就是中文，混译反而引入噪声。
 */
export function endKeyframePrompt(shot: Shot): string {
  const state = shot.end_state || shot.video_prompt_cn || shot.video_prompt;
  const style = shot.image_prompt_cn || shot.image_prompt;
  const parts: string[] = [];
  if (state) parts.push(`本镜收尾瞬间的定格画面：${state}`);
  if (style) parts.push(`场景、主体、光线与画风与以下描述保持一致：${style}`);
  return parts.join("。");
}

interface ImageApiData {
  kind: "b64" | "url";
  url?: string;
  data?: string;
  model: string;
}

export function useKeyframes() {
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  /* 尾帧（S3 共享端点帧）独立记账：与首帧是不同的图，busy / error / 上限都分开 */
  const [endBusy, setEndBusy] = useState<Record<number, boolean>>({});
  const [endErrors, setEndErrors] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(0);

  /* 串行队列：把每次生成接到上一条的尾巴上 */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const clearError = useCallback((index: number) => {
    setErrors((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  const clearEndError = useCallback((index: number) => {
    setEndErrors((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  /**
   * 整体重置：重新生成分镜（换一批镜头）时调用。
   * busy / errors / pending 都按镜头序号记，跨批次残留会把旧分镜的状态
   * 嫁接到新分镜同序号的镜头上（与视频任务残留是同一类 bug）。
   * 已在队列里跑的请求无法取消，其结果由 page 层的世代号守卫负责丢弃。
   */
  const reset = useCallback(() => {
    setBusy({});
    setErrors({});
    setEndBusy({});
    setEndErrors({});
    setPending(0);
  }, []);

  /** 生成一张关键帧（首帧或尾帧槽位）；成功返回公网 URL，失败返回 null（错误写进对应 errors） */
  const runOne = useCallback(
    async (index: number, req: KeyframeRequest, slot: "start" | "end"): Promise<string | null> => {
      const isEnd = slot === "end";
      const clearErr = isEnd ? clearEndError : clearError;
      const setBsy = isEnd ? setEndBusy : setBusy;
      const setErr = isEnd ? setEndErrors : setErrors;
      clearErr(index);
      setBsy((prev) => ({ ...prev, [index]: true }));
      try {
        const res = await fetch("/api/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: req.profileId || undefined,
            prompt: req.prompt,
            size: req.size || "1024x1024",
            preferUrl: true,
          }),
        });
        const json = await res.json();
        if (!json.ok) {
          setErr((prev) => ({ ...prev, [index]: json.message ?? "关键帧生成失败" }));
          return null;
        }
        const d = json.data as ImageApiData;
        if (!d?.url) {
          setErr((prev) => ({
            ...prev,
            [index]:
              "该图片服务只返回了 base64，没有公网 URL。视频首帧必须是上游能自己拉取的图片地址，请换用会返回 URL 的图片服务（或让该 profile 走支持 url 的网关）。",
          }));
          return null;
        }
        return d.url;
      } catch (e) {
        setErr((prev) => ({ ...prev, [index]: `关键帧请求失败：${String(e)}` }));
        return null;
      } finally {
        setBsy((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      }
    },
    [clearError, clearEndError]
  );

  /** 生成一个分镜的首帧关键帧（进串行队列） */
  const generate = useCallback(
    (index: number, req: KeyframeRequest): Promise<string | null> => {
      setPending((n) => n + 1);
      return enqueue(() => runOne(index, req, "start")).finally(() => setPending((n) => Math.max(0, n - 1)));
    },
    [enqueue, runOne]
  );

  /** 生成一个分镜的尾帧关键帧（同一条串行队列，逐张来） */
  const generateEnd = useCallback(
    (index: number, req: KeyframeRequest): Promise<string | null> => {
      setPending((n) => n + 1);
      return enqueue(() => runOne(index, req, "end")).finally(() => setPending((n) => Math.max(0, n - 1)));
    },
    [enqueue, runOne]
  );

  /**
   * 批量生成（进同一条串行队列，逐张来）。
   * 返回 index → URL 的成功映射；失败的项留在 errors 里。
   */
  const generateMany = useCallback(
    async (items: KeyframeBatchItem[]): Promise<Map<number, string>> => {
      const out = new Map<number, string>();
      for (const { index, req } of items) {
        const url = await generate(index, req);
        if (url) out.set(index, url);
      }
      return out;
    },
    [generate]
  );

  const anyBusy = Object.keys(busy).length > 0 || Object.keys(endBusy).length > 0;

  return {
    busy,
    errors,
    endBusy,
    endErrors,
    pending,
    anyBusy,
    generate,
    generateEnd,
    generateMany,
    clearError,
    clearEndError,
    reset,
  };
}
