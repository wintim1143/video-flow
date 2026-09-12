/**
 * 视频接口的最小调用间隔闸门（本地限流）。
 *
 * ## 关键区分：生成很紧（1 次/分钟），查询很松（~3 秒）
 *
 * 免费档的 1 次/分钟配额只约束**生成**（`POST /videos` 建任务），**查询宽松得多**。
 * 两者绝不可共用一把锁 —— 早期版本共用，导致刚建完任务就得干等 60 秒才查得到结果，
 * 一个 5 秒的视频要一分钟才知道成没成。
 *
 * 上游实测（同一个 taskId 直连 `/agnesapi` 连查，统计 429 次数）：
 *
 * | 查询间隔 | 样本 | 结果 |
 * |---|---|---|
 * | 1.2s | 4 次 | 全 200 |
 * | 2.0s | 8 次 | **第 4、8 次 429**，`Retry-After: 2`，body `too many video status queries` |
 * | 3.0s | 10 次 | 全 200（但经应用层 3.5s 实测 6 次仍有 1 次 429 —— 非确定性） |
 * | **4.0s** | **15 次（整 60s）** | **全 200 ✅** |
 *
 * 即查询侧是「每窗口约 15 次 / 60s」的宽松限流，官方文档建议的「每隔 1–2 秒查询一次」
 * 会周期性地撞上 429。所以默认取 4s，并且**必须尊重上游返回的 `Retry-After`**（已实现，
 * 且 429 只当作「等一下」重新排期，绝不判任务失败）。
 *
 * | 闸门 | 约束 | 默认 | 环境变量 |
 * |---|---|---|---|
 * | create | 建任务（消耗生成配额） | 60s | `VIDEO_CREATE_MIN_INTERVAL_MS` |
 * | query  | 查询（宽松，防连打） | 4s | `VIDEO_QUERY_MIN_INTERVAL_MS` |
 *
 * 设为 0 即关闭对应闸门。
 *
 * 已知边界：状态是模块级内存，仅覆盖单进程。dev server / 单实例部署够用；
 * 多实例部署需要换成 Redis 之类的共享计数（届时只需替换本文件导出的几个函数）。
 */

const DEFAULT_CREATE_INTERVAL_MS = 60_000;
const DEFAULT_QUERY_INTERVAL_MS = 4_000;

/** 两类调用：只有 create 消耗生成配额 */
export type VideoCallKind = "create" | "query";

/** 上一次真正打到上游的时间戳（ms），两类分开记 */
const lastCallAt: Record<VideoCallKind, number> = { create: 0, query: 0 };

const ENV_KEY: Record<VideoCallKind, string> = {
  create: "VIDEO_CREATE_MIN_INTERVAL_MS",
  query: "VIDEO_QUERY_MIN_INTERVAL_MS",
};

const DEFAULT_INTERVAL: Record<VideoCallKind, number> = {
  create: DEFAULT_CREATE_INTERVAL_MS,
  query: DEFAULT_QUERY_INTERVAL_MS,
};

function intervalMs(kind: VideoCallKind): number {
  const raw = Number(process.env[ENV_KEY[kind]] ?? DEFAULT_INTERVAL[kind]);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_INTERVAL[kind];
  return raw;
}

/** 生成（建任务）的最小间隔 */
export function videoCreateMinIntervalMs(): number {
  return intervalMs("create");
}

/** 查询的最小间隔（宽松；上游约 15 次/60s，实测 4s 间隔整分钟无 429） */
export function videoQueryMinIntervalMs(): number {
  return intervalMs("query");
}

export type GateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

/** 现在能不能发这一类调用？不能则给出还要等多久 */
export function checkVideoGate(kind: VideoCallKind, now: number = Date.now()): GateVerdict {
  const interval = intervalMs(kind);
  if (interval <= 0) return { ok: true };
  const elapsed = now - lastCallAt[kind];
  if (elapsed >= interval) return { ok: true };
  return { ok: false, retryAfterMs: interval - elapsed };
}

/** 发上游请求**之前**调用（无论成功失败都算消耗一次配额） */
export function markVideoCall(kind: VideoCallKind, now: number = Date.now()): void {
  lastCallAt[kind] = now;
}

export interface GateWindow {
  minIntervalMs: number;
  /** 距离下一次允许调用还要等多久；0 表示现在就可以 */
  retryAfterMs: number;
}

/** 给前端展示的闸门快照（不消耗配额） */
export function videoGateSnapshot(now: number = Date.now()): {
  create: GateWindow;
  query: GateWindow;
} {
  const windowOf = (kind: VideoCallKind): GateWindow => {
    const verdict = checkVideoGate(kind, now);
    return {
      minIntervalMs: intervalMs(kind),
      retryAfterMs: verdict.ok ? 0 : verdict.retryAfterMs,
    };
  };
  return { create: windowOf("create"), query: windowOf("query") };
}

/** 仅测试用：清空闸门状态 */
export function resetVideoGate(): void {
  lastCallAt.create = 0;
  lastCallAt.query = 0;
}
