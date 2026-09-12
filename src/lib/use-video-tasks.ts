"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 视频任务状态机 + 轮询调度。
 *
 * ## 两条时间线，别混
 *
 * - **生成冷却**（`createReadyAt`）：建任务吃生成配额，免费档 1 次/分钟。配额是**账户级**的，
 *   所以这是**全局**冷却 —— 生成了第 1 镜，其余分镜的「生成视频」按钮也要一起变灰倒计时。
 * - **查询轮询**（`nextPollAt`）：查询宽松得多（上游约 15 次/60s，实测 4s 间隔稳定）。
 *   多个分镜共用**一个**全局定时器，等待时长以服务端 `nextQueryAfterMs` 为准。
 *
 * 早期版本把两者合成一把锁，导致建完任务要干等 60 秒才查得到结果 —— 已修正。
 *
 * 状态：idle → queued → running → completed | failed
 */

export type VideoTaskUiStatus = "queued" | "running" | "completed" | "failed" | "unknown";

export interface VideoTaskUi {
  taskId: string;
  profileId?: string;
  status: VideoTaskUiStatus;
  progress?: number;
  videoUrl?: string;
  error?: string;
  provider?: string;
  mode?: string;
  /** 建任务时用的完整 prompt，便于失败后重试与溯源 */
  prompt: string;
  createdAt: number;
  updatedAt: number;
  /** 下次允许查询的时间戳（服务端查询闸门发牌） */
  nextPollAt: number;
}

export interface CreateVideoPayload {
  prompt: string;
  seconds?: number;
  aspectRatio?: string;
  size?: string;
  mode?: string;
  firstFrame?: string;
  lastFrame?: string;
  images?: string[];
  audios?: string[];
  profileId?: string;
}

const STORAGE_KEY = "video-flow:video-tasks:v1";

/** 服务端没给等待时间时的兜底轮询间隔：实测 4s 间隔整 60s 无 429 */
const DEFAULT_POLL_MS = 4_000;

/** 轮询下限，防止服务端返回 0 时变成忙轮询 */
const MIN_POLL_MS = 1_500;

type TaskMap = Record<number, VideoTaskUi>;

function isPending(t: VideoTaskUi): boolean {
  return t.status === "queued" || t.status === "running" || t.status === "unknown";
}

/** 把服务端给的毫秒数收敛到 [MIN_POLL_MS, ∞)；缺省用 DEFAULT_POLL_MS */
function pollDelay(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_POLL_MS;
  return Math.max(n, MIN_POLL_MS);
}

export function useVideoTasks() {
  const [tasks, setTasks] = useState<TaskMap>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 生成配额冷却结束时间戳（全局）。
   * 建任务成功后按服务端 `nextCreateAfterMs` 设置；被 429 拦下时同样设置。
   */
  const [createReadyAt, setCreateReadyAt] = useState(0);

  /* 轮询回调里要读最新状态，但不希望把 tasks 写进依赖导致定时器反复重建 */
  const tasksRef = useRef<TaskMap>({});
  tasksRef.current = tasks;
  const inFlight = useRef(false);

  /* ── 持久化：刷新页面后任务不丢（否则轮询链断掉，只能等任务过期） ── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as TaskMap;
      const now = Date.now();
      const restored: TaskMap = {};
      for (const [k, t] of Object.entries(saved)) {
        if (!t?.taskId) continue;
        /* 恢复时把 nextPollAt 收敛到现在，避免刷新后立刻打一次上游 */
        restored[Number(k)] = { ...t, nextPollAt: Math.max(t.nextPollAt ?? now, now) };
      }
      setTasks(restored);
    } catch {
      /* 坏数据忽略 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      /* 配额满/隐私模式忽略 */
    }
  }, [tasks]);

  const patch = useCallback((index: number, next: Partial<VideoTaskUi>) => {
    setTasks((prev) => {
      const cur = prev[index];
      if (!cur) return prev;
      return { ...prev, [index]: { ...cur, ...next, updatedAt: Date.now() } };
    });
  }, []);

  /** 查一次任务 */
  const poll = useCallback(async (index: number) => {
    const t = tasksRef.current[index];
    if (!t || !isPending(t)) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const qs = new URLSearchParams({ taskId: t.taskId });
      if (t.profileId) qs.set("profileId", t.profileId);
      const res = await fetch(`/api/video?${qs.toString()}`);
      const json = await res.json();

      if (!json.ok) {
        /*
         * 限流：本地闸门回 `THROTTLED`，上游查询回 429 `UPSTREAM` + Retry-After。
         * 两者都只是「等一下」，**绝不能判失败** —— 否则一次瞬时限流就把还在跑的任务钉死。
         */
        if (res.status === 429 || json.code === "THROTTLED") {
          patch(index, { nextPollAt: Date.now() + pollDelay(json.retryAfterMs) });
          return;
        }
        patch(index, {
          status: "failed",
          error: json.message ?? "查询失败",
          nextPollAt: Number.MAX_SAFE_INTEGER,
        });
        return;
      }

      const settled = json.status === "completed" || json.status === "failed";
      patch(index, {
        status: json.status,
        progress: json.progress,
        videoUrl: json.videoUrl,
        error: json.error,
        nextPollAt: settled ? Number.MAX_SAFE_INTEGER : Date.now() + pollDelay(json.nextQueryAfterMs),
      });
    } catch (e) {
      /* 网络抖动：不判失败，等一轮再说 */
      patch(index, { nextPollAt: Date.now() + DEFAULT_POLL_MS, error: `查询请求失败：${String(e)}` });
    } finally {
      inFlight.current = false;
    }
  }, [patch]);

  /* ── 单一全局定时器：取「最早到点」的那个待查任务 ── */
  const nextDue = useMemo(() => {
    const pending = Object.entries(tasks).filter(([, t]) => isPending(t));
    if (!pending.length) return null;
    const [index, task] = pending.reduce((a, b) => (a[1].nextPollAt <= b[1].nextPollAt ? a : b));
    return { index: Number(index), at: task.nextPollAt };
  }, [tasks]);

  useEffect(() => {
    if (!nextDue) return;
    const delay = Math.max(0, nextDue.at - Date.now());
    const id = setTimeout(() => void poll(nextDue.index), delay);
    return () => clearTimeout(id);
  }, [nextDue, poll]);

  /** 建任务。返回 true 表示任务已建立（不代表生成完成） */
  const create = useCallback(
    async (index: number, payload: CreateVideoPayload): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.ok) {
          const retryAfterMs = Number(json.retryAfterMs) || 0;
          /* 生成配额被拦（本地闸门或上游 429）：把冷却同步给全局，让所有按钮一起倒计时 */
          if (res.status === 429 && retryAfterMs > 0) {
            setCreateReadyAt(Date.now() + retryAfterMs);
          }
          setError(
            retryAfterMs > 0
              ? `${json.message ?? "建任务失败"}（约 ${Math.ceil(retryAfterMs / 1000)}s 后可重试）`
              : (json.message ?? "建任务失败")
          );
          return false;
        }
        const now = Date.now();
        setCreateReadyAt(now + (Number(json.nextCreateAfterMs) || 0));
        setTasks((prev) => ({
          ...prev,
          [index]: {
            taskId: json.taskId,
            profileId: payload.profileId,
            status: json.status ?? "queued",
            progress: json.progress,
            provider: json.provider,
            mode: json.mode,
            prompt: payload.prompt,
            createdAt: now,
            updatedAt: now,
            /* 注意用的是「查询」等待时间，不是生成冷却 —— 所以建完几秒内就能看到进度 */
            nextPollAt: now + pollDelay(json.nextQueryAfterMs),
          },
        }));
        return true;
      } catch (e) {
        setError(`建任务请求失败：${String(e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /** 清掉某个分镜的视频（不影响其它分镜） */
  const remove = useCallback((index: number) => {
    setTasks((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  /** 清空全部任务（换 brief / 一键重置时用） */
  const clearAll = useCallback(() => {
    setTasks({});
    setCreateReadyAt(0);
  }, []);

  /** 立即查询（用于「立即刷新」按钮；查询不限流，通常立即生效） */
  const refreshNow = useCallback(
    (index: number) => {
      patch(index, { nextPollAt: Date.now() });
    },
    [patch]
  );

  return {
    tasks,
    create,
    remove,
    clearAll,
    refreshNow,
    /** 生成配额的全局冷却结束时间戳；> Date.now() 表示现在不能建任务 */
    createReadyAt,
    error,
    setError,
    busy,
  };
}
