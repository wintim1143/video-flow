"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AspectRatio, Outline, Shot, Storyboard, StyleSpec } from "@/lib/schema";
import { ASPECT_LABEL, ShotSchema, formatTimecode } from "@/lib/schema";
import { fingerprint } from "@/lib/fingerprint";
import { allImagePrompts, allVideoPrompts, bundleAll, toMarkdown, wholeVideoPrompt } from "@/lib/exports";
import { suggestShotCount } from "@/lib/prompts";
import type { LlmConfigsResponse, LlmProfileSafe } from "@/lib/llm-types";
import { useVideoTasks, type CreateVideoPayload } from "@/lib/use-video-tasks";
import { keyframeSizeFor, useKeyframes } from "@/lib/use-keyframes";
import { StyleEditor } from "@/components/StyleEditor";
import { StyleTestImage } from "@/components/StyleTestImage";
import { Timeline } from "@/components/Timeline";
import { ShotRow } from "@/components/ShotRow";
import { CopyButton } from "@/components/CopyButton";
import { ProgressModal } from "@/components/ProgressModal";

type Tab = "input" | "style" | "shots";
type ApiError = { code: string; message: string; detail?: string };

/**
 * App / 软件功能演示类需求识别：视频模型渲染不出像素级一致的 UI 与可读文字，
 * 分镜式生成出来的「界面」必然是模糊的假界面 —— 这类需求应在需求页先给出范式提示。
 */
const APP_DEMO_RE = /\bapp\b|小程序|软件|客户端|播放器|界面|交互|功能演示|录屏|网页版|手机应用/i;

function isAppDemoBrief(brief: string): boolean {
  return APP_DEMO_RE.test(brief);
}

const EXAMPLES = [
  {
    label: "便携咖啡机",
    text: "一款便携式胶囊咖啡机「BrewGo」，主打 30 秒出杯、办公室和露营都能用，目标人群是 25-35 岁城市白领，希望突出小巧、精致、随时来一杯的松弛感。",
  },
  {
    label: "高端电动 SUV",
    text: "高端纯电 SUV「Aurora X」上市宣传片，强调静谧性、3.8 秒破百、智能座舱，画面要克制高级，避免俗气。",
  },
  {
    label: "母婴洗衣液",
    text: "母婴级温和洗衣液，主打无荧光剂、宝宝贴身衣物可用，希望传达安心、柔软、家庭陪伴的感觉。",
  },
];

const DURATION_PRESETS = [5, 15, 30, 60];

/** 默认时长（与 schema.ts 的 targetDuration default 保持一致，改一处必须改两处） */
const DEFAULT_DURATION = 5;

/** 工作台本地持久化：刷新页面不丢进度（参考图 data URL 太大，刻意不入库） */
const STORAGE_KEY = "video-flow:workbench:v1";

interface Persisted {
  brief: string;
  aspectRatio: AspectRatio;
  targetDuration: number;
  shotCount: number;
  style: StyleSpec | null;
  shots: Shot[] | null;
  sbMeta: Storyboard["meta"] | null;
  globalNegative: string;
  globalNegativeCn: string;
  consistencyNotes: string[];
  outline: Outline | null;
  tab: Tab;
  textProfileId: string;
  imageProfileId: string;
  videoProfileId: string;
  /** 生成这批分镜时的输入指纹 —— 用来判断「输入是否在生成之后被改过」（R1.2） */
  sbInputFingerprint: string;
}

/** /api/export 的回执（R6.1 归档结果） */
interface ArchiveResult {
  runId: string;
  dir: string;
  relDir: string;
  written: Array<{ name: string; bytes: number }>;
  failed: Array<{ name: string; reason: string }>;
  totalBytes: number;
}

/** 归档清单里的字节数展示 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 参考图压缩：最长边 ≤1024px、JPEG 0.85，控制在几百 KB（vision 输入足够且省 token） */
function fileToCompressedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    img.src = url;
  });
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("input");
  const [brief, setBrief] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [targetDuration, setTargetDuration] = useState(DEFAULT_DURATION);
  const [shotCount, setShotCount] = useState(() => suggestShotCount(DEFAULT_DURATION));
  const [adjustNote, setAdjustNote] = useState("");

  const [style, setStyle] = useState<StyleSpec | null>(null);
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [sbMeta, setSbMeta] = useState<Storyboard["meta"] | null>(null);
  const [globalNegative, setGlobalNegative] = useState("");
  const [globalNegativeCn, setGlobalNegativeCn] = useState("");
  const [consistencyNotes, setConsistencyNotes] = useState<string[]>([]);

  // ── 参考图（图生风格路径）：有图时风格从图提取，文字仅作内容补充 ──
  const [refImage, setRefImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [imgLoading, setImgLoading] = useState(false);

  /* ── 产物归档（R6.1）：把成片 mp4 与关键帧图真正落到 .data/artifacts/ ── */
  const [archiving, setArchiving] = useState(false);
  const [archiveResult, setArchiveResult] = useState<ArchiveResult | null>(null);

  const [loading, setLoading] = useState<"" | "style" | "shots">("");
  const [error, setError] = useState<ApiError | null>(null);
  /** 当前生成请求的中断控制器（弹窗「取消生成」用） */
  const abortRef = useRef<AbortController | null>(null);

  // ── 分镜流式生成进度（两段式：大纲 → 逐镜）──
  const [outline, setOutline] = useState<Outline | null>(null);
  /** 生成这批分镜时的输入指纹（R1.2：与当前输入比对，判断结果是否已过期） */
  const [sbInputFingerprint, setSbInputFingerprint] = useState("");
  const [failedShots, setFailedShots] = useState<number[]>([]);
  const [progress, setProgress] = useState<{ phase: "" | "outline" | "shots"; done: number; total: number; last: string }>(
    { phase: "", done: 0, total: 0, last: "" }
  );

  // ── LLM profiles（脱敏，来自 /api/llm-configs）──
  const [profiles, setProfiles] = useState<LlmConfigsResponse>({ text: [], image: [], video: [] });
  const [textProfileId, setTextProfileId] = useState("");
  const [imageProfileId, setImageProfileId] = useState("");
  const [videoProfileId, setVideoProfileId] = useState("");

  /* ── 视频任务：状态 + 全局单一轮询器（查询按 1–2s，生成配额另有全局冷却） ── */
  const {
    tasks: videoTasks,
    create: createVideoTask,
    remove: removeVideoTask,
    clearAll: clearVideoTasks,
    refreshNow: refreshVideoTask,
    createReadyAt: videoCreateReadyAt,
    error: videoError,
    setError: setVideoError,
    busy: videoBusy,
  } = useVideoTasks();

  /* ── 闸门 2：关键帧（串行队列，逐镜出一张首帧图 → 供 I2V 使用） ── */
  const {
    busy: keyframeBusyMap,
    errors: keyframeErrorMap,
    pending: keyframePending,
    anyBusy: keyframeAnyBusy,
    generate: generateKeyframe,
    generateMany: generateKeyframes,
    clearError: clearKeyframeError,
  } = useKeyframes();

  /* ── 本地持久化：挂载后恢复一次 → 之后每次变更防抖写回 ──
   * 只在 useEffect 里读写，保证 SSR 首屏与客户端首帧一致（不产生 hydration 警告）。 */
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Persisted>;
        if (typeof s.brief === "string") setBrief(s.brief);
        if (s.aspectRatio === "9:16" || s.aspectRatio === "16:9" || s.aspectRatio === "1:1") {
          setAspectRatio(s.aspectRatio);
        }
        if (typeof s.targetDuration === "number") setTargetDuration(s.targetDuration);
        if (typeof s.shotCount === "number") setShotCount(s.shotCount);
        if (s.style) setStyle(s.style);
        if (s.shots?.length) {
          /* 过一遍 schema 再恢复：老版本存下的分镜缺新字段（如 keyframe_attempts），
             zod 的 catch 会补上默认值；否则 undefined 一路带到 +1 会变成 NaN。 */
          const parsed = ShotSchema.array().safeParse(s.shots);
          if (parsed.success) setShots(parsed.data);
        }
        if (s.sbMeta) setSbMeta(s.sbMeta);
        if (typeof s.globalNegative === "string") setGlobalNegative(s.globalNegative);
        if (typeof s.globalNegativeCn === "string") setGlobalNegativeCn(s.globalNegativeCn);
        if (Array.isArray(s.consistencyNotes)) setConsistencyNotes(s.consistencyNotes);
        if (s.outline) setOutline(s.outline);
        if (typeof s.textProfileId === "string") setTextProfileId(s.textProfileId);
        if (typeof s.imageProfileId === "string") setImageProfileId(s.imageProfileId);
        if (typeof s.videoProfileId === "string") setVideoProfileId(s.videoProfileId);
        if (typeof s.sbInputFingerprint === "string") setSbInputFingerprint(s.sbInputFingerprint);
        // 只在对应数据确实存在时才恢复到该 tab，避免落到被禁用的空 tab
        if (s.tab === "input" || (s.tab === "style" && s.style) || (s.tab === "shots" && s.shots?.length)) {
          setTab(s.tab);
        }
      }
    } catch {
      /* 本地数据损坏 / 隐私模式禁用 localStorage → 忽略，按全新会话走 */
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      try {
        const payload: Persisted = {
          brief,
          aspectRatio,
          targetDuration,
          shotCount,
          style,
          shots,
          sbMeta,
          globalNegative,
          globalNegativeCn,
          consistencyNotes,
          outline,
          tab,
          textProfileId,
          imageProfileId,
          videoProfileId,
          sbInputFingerprint,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        /* 超配额（如分镜极多）→ 静默放弃，不影响使用 */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [
    restored,
    brief,
    aspectRatio,
    targetDuration,
    shotCount,
    style,
    shots,
    sbMeta,
    globalNegative,
    globalNegativeCn,
    consistencyNotes,
    outline,
    tab,
    textProfileId,
    imageProfileId,
    videoProfileId,
    sbInputFingerprint,
  ]);

  /** 清空本地保存的工作进度（回到全新会话） */
  const clearPersisted = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  /** 一键重置：清本地保存 + 清内存状态（不动磁盘上已导出的文件） */
  const resetAll = useCallback(() => {
    if (!window.confirm("清空本地保存的需求 / 风格 / 分镜，回到空白页？（已导出的文件不受影响）")) return;
    clearPersisted();
    setBrief("");
    setAdjustNote("");
    setStyle(null);
    setShots(null);
    setSbMeta(null);
    setOutline(null);
    setGlobalNegative("");
    setGlobalNegativeCn("");
    setConsistencyNotes([]);
    setFailedShots([]);
    setRefImage(null);
    setSbInputFingerprint("");
    setArchiveResult(null);
    setError(null);
    setProgress({ phase: "", done: 0, total: 0, last: "" });
    clearVideoTasks();
    setVideoError(null);
    setTargetDuration(DEFAULT_DURATION);
    setShotCount(suggestShotCount(DEFAULT_DURATION));
    setTab("input");
  }, [clearPersisted, clearVideoTasks, setVideoError]);

  useEffect(() => {
    fetch("/api/llm-configs")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) return;
        const data = j.data as LlmConfigsResponse;
        setProfiles(data);
        // 默认选中第一个
        setTextProfileId((prev) => (prev && data.text.some((p) => p.id === prev) ? prev : (data.text[0]?.id ?? "")));
        setImageProfileId((prev) => (prev && data.image.some((p) => p.id === prev) ? prev : (data.image[0]?.id ?? "")));
        setVideoProfileId((prev) => (prev && data.video.some((p) => p.id === prev) ? prev : (data.video[0]?.id ?? "")));
      })
      .catch(() => {
        /* 配置读取失败不阻塞页面，生成时会报具体错误 */
      });
  }, []);

  /* vision 模型 = 未显式标记纯文本的（缺省视为支持，向后兼容） */
  const visionTextProfiles = profiles.text.filter((p) => p.vision !== false);
  /* 有参考图时只能在 vision 模型里选 */
  const selectableTextProfiles = refImage ? visionTextProfiles : profiles.text;

  /* 上传参考图后：当前选中的若是纯文本模型（如 DS），自动切到第一个 vision 模型 */
  useEffect(() => {
    if (refImage && textProfileId && !visionTextProfiles.some((p) => p.id === textProfileId)) {
      setTextProfileId(visionTextProfiles[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refImage]);

  // ── tabs 可用性：有数据才开放切换 ──
  const canStyle = !!style;
  const canShots = !!shots && !!style;
  const tabs: Array<{ key: Tab; label: string; disabled: boolean }> = [
    { key: "input", label: "① 需求", disabled: false },
    { key: "style", label: "② 风格", disabled: !canStyle },
    { key: "shots", label: "③ 分镜", disabled: !canShots },
  ];

  /* ── 视频生成：只有配了 video profile 才出现入口 ── */
  const videoEnabled = profiles.video.length > 0;

  const handleCreateVideo = useCallback(
    (index: number, payload: CreateVideoPayload) => {
      setVideoError(null);
      void createVideoTask(index, { ...payload, profileId: videoProfileId || undefined });
    },
    [createVideoTask, videoProfileId, setVideoError]
  );

  /* ── 闸门 2：关键帧。生成成功即写回 Shot，之后 buildPayload 自动带上 first_frame ── */
  const keyframeEnabled = profiles.image.length > 0;
  /* 用顶层的 aspectRatio 状态算尺寸（storyboard 在本函数体后面才声明，不能提前引用） */
  const kfSize = keyframeSizeFor(aspectRatio);

  const handleGenerateKeyframe = useCallback(
    async (index: number, prompt: string) => {
      /* 先记一次尝试：成败都计数，否则失败的请求会绕过 R3.2 的上限 */
      setShots((prev) =>
        prev
          ? prev.map((s) => (s.index === index ? { ...s, keyframe_attempts: (s.keyframe_attempts ?? 0) + 1 } : s))
          : prev
      );
      const url = await generateKeyframe(index, {
        prompt,
        profileId: imageProfileId || undefined,
        size: kfSize,
      });
      if (!url) return;
      setShots((prev) =>
        prev
          ? prev.map((s) => (s.index === index ? { ...s, keyframe_url: url, keyframe_prompt_used: prompt } : s))
          : prev
      );
    },
    [generateKeyframe, imageProfileId, kfSize]
  );

  const handleClearKeyframe = useCallback((index: number) => {
    clearKeyframeError(index);
    setShots((prev) =>
      prev
        ? prev.map((s) => (s.index === index ? { ...s, keyframe_url: "", keyframe_prompt_used: "" } : s))
        : prev
    );
  }, [clearKeyframeError]);

  /** 一键补齐缺失的关键帧：串行逐张（避免并发打爆图接口），且只处理**还没有首帧**的镜 ——
   *  否则「一键」会把已就位的镜全部重烧一遍图配额。想换掉已就位的那张走单镜重出。 */
  const handleGenerateAllKeyframes = useCallback(async () => {
    const missing = (shots ?? []).filter((s) => !s.keyframe_url);
    if (!missing.length) return;
    /* 发起即计数，与单镜口径一致 */
    setShots((prev) =>
      prev
        ? prev.map((s) =>
            missing.some((m) => m.index === s.index) ? { ...s, keyframe_attempts: (s.keyframe_attempts ?? 0) + 1 } : s
          )
        : prev
    );
    const items = missing.map((s) => ({
      index: s.index,
      req: {
        prompt: s.image_prompt || s.video_prompt,
        profileId: imageProfileId || undefined,
        size: kfSize,
      },
    }));
    const done = await generateKeyframes(items);
    if (!done.size) return;
    setShots((prev) =>
      prev
        ? prev.map((s) =>
            done.has(s.index)
              ? { ...s, keyframe_url: done.get(s.index)!, keyframe_prompt_used: s.image_prompt || s.video_prompt }
              : s
          )
        : prev
    );
  }, [shots, generateKeyframes, imageProfileId, kfSize]);

  /** 已就位的关键帧数量（面板进度用） */
  const keyframeDone = (shots ?? []).filter((s) => s.keyframe_url).length;
  /** 还缺几张 —— 批量按钮只补这些，全部就位时按钮转为禁用 */
  const keyframeMissing = (shots ?? []).length - keyframeDone;

  /* ── R1.2：当前输入 vs 这批分镜的来源输入 ──
     不一致 = 结果已过期。这是全流程里最贵的错误：改了 brief 却拿旧分镜继续往下走，
     后面每一步（关键帧、视频）都真烧配额，产物却对不上新输入，且没有任何 UI 信号。 */
  const currentInputFingerprint = fingerprint(brief, aspectRatio, targetDuration, shotCount, refImage?.dataUrl ?? "");
  const inputDrifted = Boolean(shots?.length && sbInputFingerprint && currentInputFingerprint !== sbInputFingerprint);

  const switchTab = useCallback(
    (k: Tab) => {
      const dis = tabs.find((t) => t.key === k)?.disabled;
      if (dis) return;
      setTab(k);
      setError(null);
    },
    [tabs]
  );

  // 拆一个 storyboard 组装函数（便于手动编辑 shots 后仍能导出完整 storyboard）
  function buildStoryboard(): Storyboard {
    const list = shots ?? [];
    return {
      meta: sbMeta ?? { title: "", aspect_ratio: aspectRatio, target_duration: targetDuration, shots_count: list.length },
      shots: list,
      global_negative: globalNegative,
      consistency_notes: consistencyNotes,
    };
  }

  function patchShot(index: number, next: Shot) {
    setShots((prev) => (prev ? prev.map((s) => (s.index === index ? next : s)) : prev));
  }

  /* 从原来的「return 之前」提到这里：归档回调（useCallback）需要引用它，
     而 hooks 必须先于 return，所以 storyboard 得先落地。 */
  const storyboard = canShots ? buildStoryboard() : null;

  /**
   * 归档本次产出（R6.1）。
   *
   * 「预览 URL」不等于「交付物」—— 上游链接会随工作台的任务记录一起被清掉。这里把成片 mp4
   * 与关键帧图交服务端代拉落到本地，同时写三份文本交付物（JSON / Markdown / 整片 prompt）。
   * 还没有成片也允许归档：风格与分镜 prompt 本身就是交付物的一部分。
   */
  const handleArchive = useCallback(async () => {
    if (!style || !storyboard) return;
    setArchiving(true);
    setError(null);
    try {
      const assets: Array<{ name: string; url: string }> = [];
      for (const s of storyboard.shots) {
        const n = String(s.index).padStart(2, "0");
        if (s.keyframe_url) assets.push({ name: `shot-${n}-keyframe.png`, url: s.keyframe_url });
        const v = videoTasks[s.index]?.videoUrl;
        if (v) assets.push({ name: `shot-${n}.mp4`, url: v });
      }
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [
            { name: "storyboard.json", content: bundleAll(storyboard, style) },
            { name: "storyboard.md", content: toMarkdown(storyboard, style) },
            {
              name: "whole-prompt.txt",
              content: wholeVideoPrompt(storyboard, style, { entities: outline?.entities }),
            },
          ],
          assets,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError({ code: json.code ?? "UPSTREAM", message: json.message ?? "归档失败", detail: json.detail });
        return;
      }
      setArchiveResult(json as ArchiveResult);
    } catch (e) {
      setError({ code: "NETWORK", message: "归档请求失败", detail: String(e) });
    } finally {
      setArchiving(false);
    }
  }, [style, storyboard, videoTasks, outline]);

  async function genStyle(adjust?: string) {
    if (!brief.trim() && !refImage) {
      setError({ code: "BAD_INPUT", message: "请填写广告描述，或上传一张参考图" });
      return;
    }
    if (refImage && !visionTextProfiles.length) {
      setError({
        code: "VISION_UNSUPPORTED",
        message:
          "当前配置里没有支持视觉的模型，无法从参考图提取风格。请在 llm.config.json 给多模态模型配一个 profile（DeepSeek 等纯文本模型请标 vision: false），或去掉参考图改用文字描述。",
      });
      return;
    }
    if (!profiles.text.length) {
      setError({
        code: "CONFIG_MISSING",
        message: "尚未配置文本 LLM，已跳过调用（应用其余功能可正常使用）",
      });
      return;
    }
    setLoading("style");
    setError(null);
    abortRef.current = new AbortController();
    try {
      const payload = {
        brief: adjust?.trim() ? `${brief}\n\n【风格调整要求】${adjust.trim()}` : brief,
        aspectRatio,
        targetDuration,
        profileId: textProfileId || undefined,
        imageDataUrl: refImage?.dataUrl,
      };
      const res = await fetch("/api/style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortRef.current.signal,
      });
      const json = await res.json();
      if (!json.ok) {
        setError({ code: json.code, message: json.message, detail: json.detail });
        return;
      }
      setStyle(json.data as StyleSpec);
      setShotCount(suggestShotCount(targetDuration));
      setTab("style");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // 用户取消，静默退出
      setError({ code: "NETWORK", message: "请求失败，请确认 dev server 在运行", detail: String(e) });
    } finally {
      setLoading("");
      abortRef.current = null;
    }
  }

  async function genShots() {
    /* 重入保护：生成期间重复点击不重复发起（R1.2 去重的第一层，防误触白烧配额） */
    if (loading) return;
    if (!style) return;
    if (!profiles.text.length) {
      setError({
        code: "CONFIG_MISSING",
        message: "尚未配置文本 LLM，已跳过调用（应用其余功能可正常使用）",
      });
      return;
    }
    setLoading("shots");
    setError(null);
    setShots(null);
    setOutline(null);
    setFailedShots([]);
    /* 捕获**发起瞬间**的输入指纹（而不是完成时的）：它才是这批分镜的来源标识（R1.2）。
       不在这里清空已有的指纹 —— 生成失败时旧结果仍对应旧输入，清掉会误报「输入已变更」。 */
    const fpAtStart = fingerprint(brief, aspectRatio, targetDuration, shotCount, refImage?.dataUrl ?? "");
    setProgress({ phase: "outline", done: 0, total: shotCount, last: "正在生成分镜大纲…" });
    try {
      const res = await fetch("/api/shots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, aspectRatio, targetDuration, style, shotCount, profileId: textProfileId || undefined }),
      });
      /* 非 SSE 的 JSON 响应 = 参数/配置类错误 */
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("text/event-stream")) {
        const json = await res.json();
        setError({ code: json.code ?? "UPSTREAM", message: json.message ?? "请求失败", detail: json.detail });
        setProgress({ phase: "", done: 0, total: 0, last: "" });
        return;
      }

      /* 读取 SSE 事件流 */
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");
      const decoder = new TextDecoder();
      let buf = "";
      const handleEvent = (raw: string) => {
        if (!raw.trim()) return;
        let ev: {
          type: string;
          message?: string;
          outline?: Outline;
          shot?: Shot;
          index?: number;
          failedIndexes?: number[];
          code?: string;
          detail?: string;
        };
        try {
          ev = JSON.parse(raw);
        } catch {
          return;
        }
        if (ev.type === "outline" && ev.outline) {
          setOutline(ev.outline);
          setShots([]);
          const total = ev.outline.outline.length;
          setProgress((p) => ({ ...p, phase: "shots", done: 0, total, last: "大纲完成，开始逐镜生成…" }));
          setSbMeta({
            title: ev.outline.meta.title,
            aspect_ratio: ev.outline.meta.aspect_ratio || aspectRatio,
            target_duration: ev.outline.meta.target_duration || targetDuration,
            shots_count: total,
          });
          setSbInputFingerprint(fpAtStart);
          setGlobalNegative(ev.outline.global_negative);
          setGlobalNegativeCn(ev.outline.global_negative ?? "");
          setConsistencyNotes(ev.outline.consistency_notes);
          setTab("shots");
        } else if (ev.type === "shot" && ev.shot) {
          const s = ev.shot;
          setShots((prev) => {
            const list = (prev ?? []).filter((x) => x.index !== s.index);
            list.push(s);
            list.sort((a, b) => a.index - b.index);
            return list;
          });
          setProgress((p) => ({ ...p, done: p.done + 1, last: ev.message ?? `第 ${s.index} 镜完成` }));
        } else if (ev.type === "shot_error") {
          const idx = ev.index ?? 0;
          setFailedShots((prev) => (prev.includes(idx) ? prev : [...prev, idx]));
          setProgress((p) => ({ ...p, done: p.done + 1, last: ev.message ?? `第 ${idx} 镜失败` }));
        } else if (ev.type === "trace") {
          setProgress((p) => ({ ...p, last: ev.message ?? p.last }));
        } else if (ev.type === "error") {
          setError({ code: ev.code ?? "UPSTREAM", message: ev.message ?? "生成失败", detail: ev.detail });
        } else if (ev.type === "done" && ev.failedIndexes) {
          setFailedShots(ev.failedIndexes);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) handleEvent(line.slice(6));
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // 用户取消，静默退出
      setError({ code: "NETWORK", message: "请求失败，请确认 dev server 在运行", detail: String(e) });
    } finally {
      setLoading("");
      abortRef.current = null;
      setProgress((p) => ({ ...p, phase: "" }));
    }
  }

  /** 失败镜定点重试：单镜调用 /api/shot，成功后替换 */
  async function retryShot(index: number) {
    if (!style || !outline) return;
    setFailedShots((prev) => prev.filter((i) => i !== index));
    setProgress({ phase: "shots", done: 0, total: 1, last: `正在重试第 ${index} 镜…` });
    try {
      const res = await fetch("/api/shot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief,
          aspectRatio,
          targetDuration,
          style,
          outline,
          index,
          neighbors: shots ?? [],
          profileId: textProfileId || undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError({ code: json.code, message: json.message, detail: json.detail });
        setFailedShots((prev) => [...prev, index]);
        return;
      }const s = json.data as Shot;
      setShots((prev) => {
        const list = (prev ?? []).filter((x) => x.index !== s.index);
        list.push(s);
        list.sort((a, b) => a.index - b.index);
        return list;
      });
      setProgress((p) => ({ ...p, phase: "", done: 1, last: `第 ${index} 镜重试成功 · ${((json.meta?.ms ?? 0) / 1000).toFixed(1)}s` }));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        setFailedShots((prev) => [...prev, index]); // 取消重试 → 恢复失败标记
        return;
      }
      setError({ code: "NETWORK", message: "重试请求失败", detail: String(e) });
      setFailedShots((prev) => [...prev, index]);
    } finally {
      abortRef.current = null;
      setProgress((p) => ({ ...p, phase: "" })); // 任何路径都关闭弹窗
    }
  }

  return (
    <main className="mx-auto max-w-[1180px] px-6 py-6">
      {/* 顶栏 */}
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[16px] font-semibold tracking-tight">
            video<span style={{ color: "var(--accent)" }}>-flow</span>
          </h1>
          <p className="text-[11.5px] text-[var(--muted)]">
            M0 里程碑 · 文本 → 风格 → 分镜脚本（只产 prompt，不生图/不生视频）
          </p>
        </div>

        {/* 常驻 tab，可来回切换 */}
        <nav className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={t.disabled}
              onClick={() => switchTab(t.key)}
              className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                tab === t.key
                  ? "bg-[var(--accent)] font-medium text-[#041016]"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              } ${t.disabled ? "cursor-not-allowed opacity-40" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* 文本 LLM 切换（风格/分镜生成共用；有参考图时仅显示支持视觉的模型） */}
        <div className="flex items-center gap-1.5" title="用于生成风格与分镜的文本 LLM">
          <span className="text-[11px] text-[var(--muted)]">
            文本LLM{refImage ? "（视觉）" : ""}
          </span>
          <select
            className="field mono w-44"
            value={textProfileId}
            onChange={(e) => setTextProfileId(e.target.value)}
            disabled={!selectableTextProfiles.length}
          >
            {selectableTextProfiles.length ? (
              selectableTextProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            ) : (
              <option value="">无支持视觉的模型</option>
            )}
          </select>
        </div>

        {/* 链路日志入口（/logs：LLM 调用回看 + 两次运行对比 + 微调导出） */}
        <a
          href="/logs"
          className="ml-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          title="LLM 调用链路日志：回看、对比、微调导出"
        >
          链路日志
        </a>
      </header>

      {error ? (
        <div className="panel mb-5 p-4" style={{ borderColor: "var(--err)", background: "#1e1416" }}>
          <div className="text-[13px] font-medium" style={{ color: "var(--err)" }}>
            {error.message}
          </div>
          {error.code === "CONFIG_MISSING" ? (
            <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--muted)]">
              两种方式（任选其一，配置文件优先）：
              <br />① 项目根目录建 <code className="mono text-[var(--text)]">llm.config.json</code>
              （参考 <code className="mono text-[var(--text)]">llm.config.example.json</code>，支持多模型，改完刷新页面即生效）；
              <br />② 编辑 <code className="mono text-[var(--text)]">.env.local</code>，填
              <code className="mono text-[var(--text)]"> LLM_API_KEY / LLM_BASE_URL / LLM_MODEL</code>
              （BaseURL 需带 <code className="mono text-[var(--text)]">/v1</code>），保存后重启 dev server。
            </div>
          ) : null}
          {error.detail ? (
            <pre className="prompt-box mono mt-2 max-h-40 overflow-auto text-[11px] text-[var(--muted)]">
              {error.detail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* ───────── ① 需求 ───────── */}
      {tab === "input" ? (
        <div className="panel p-5">
          <label className="mb-1.5 block text-[13px] font-medium">广告需求描述</label>
          <textarea
            className="field mono"
            rows={6}
            placeholder="例如：一款便携式胶囊咖啡机「BrewGo」，主打 30 秒出杯、办公室和露营都能用，目标人群 25-35 岁城市白领…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />

          {isAppDemoBrief(brief) ? (
            <div
              className="mt-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
              style={{ borderColor: "#6b5420", background: "rgba(180, 140, 40, 0.10)" }}
            >
              <span className="font-medium">提示：这条需求更像「App 功能演示」范式。</span>
              视频模型渲染不出像素级一致的界面和可读文字，分镜式生成出的「UI」会是模糊的假界面。
              推荐做法：功能演示走
              <span className="font-medium">真机录屏</span>
              （画面里的视频画布再用 AI 让它动起来）；本工具更适合做这款 App 的
              <span className="font-medium">品牌情绪片</span>
              （氛围、痛点、人物使用感受），而不是逐帧展示功能。
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-[12px] text-[var(--muted)]">示例：</span>
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="btn" onClick={() => setBrief(ex.text)}>
                {ex.label}
              </button>
            ))}
          </div>

          {/* 参考图上传：图定风格，文字定内容 */}
          <div className="mt-5">
            <div className="mb-1.5 text-[13px] font-medium">
              参考图 <span className="text-[11.5px] font-normal text-[var(--muted)]">（可选 · 上传后从图中提取视觉风格，文字只补充产品/内容信息）</span>
            </div>
            {refImage ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={refImage.dataUrl}
                  alt={refImage.name}
                  className="h-20 w-20 rounded-lg border border-[var(--border)] object-cover"
                />
                <div className="text-[12px] text-[var(--muted)]">
                  <div className="max-w-48 truncate">{refImage.name}</div>
                  <div>风格将从此图提取</div>
                </div>
                <button type="button" className="btn" onClick={() => setRefImage(null)}>
                  移除
                </button>
              </div>
            ) : (
              <label className={`btn inline-flex cursor-pointer items-center gap-2 ${imgLoading ? "opacity-50" : ""}`}>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={imgLoading}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ""; // 允许重复选同一文件
                    if (!f) return;
                    setImgLoading(true);
                    setError(null);
                    try {
                      const dataUrl = await fileToCompressedDataUrl(f);
                      setRefImage({ dataUrl, name: f.name });
                    } catch (err) {
                      setError({ code: "BAD_INPUT", message: "图片读取失败，请换一张试试", detail: String(err) });
                    } finally {
                      setImgLoading(false);
                    }
                  }}
                />
                {imgLoading ? "处理图片中…" : "＋ 上传参考图"}
              </label>
            )}
          </div>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[13px] font-medium">目标时长</div>
              <div className="flex items-center gap-2">
                {DURATION_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="btn"
                    onClick={() => {
                      setTargetDuration(d);
                      setShotCount(suggestShotCount(d));
                    }}
                    style={targetDuration === d ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  >
                    {d}s
                  </button>
                ))}
                <input
                  type="number"
                  className="field mono w-24"
                  min={5}
                  max={180}
                  value={targetDuration}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 5;
                    setTargetDuration(v);
                    setShotCount(suggestShotCount(v));
                  }}
                />
                <span className="text-[12px] text-[var(--muted)]">秒</span>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[13px] font-medium">画幅</div>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(ASPECT_LABEL) as AspectRatio[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="btn"
                    onClick={() => setAspectRatio(r)}
                    style={aspectRatio === r ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  >
                    {ASPECT_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                loading === "style" ||
                (!brief.trim() && !refImage) ||
                !selectableTextProfiles.length ||
                (!!refImage && !visionTextProfiles.length)
              }
              onClick={() => genStyle()}
            >
              {loading === "style" ? (refImage ? "提取风格中…" : "匹配风格中…") : refImage ? "从参考图提取风格 →" : "匹配风格 →"}
            </button>
            {refImage && !visionTextProfiles.length ? (
              <span className="text-[12px]" style={{ color: "var(--err)" }}>
                配置里没有支持视觉的模型（llm.config.json 中给多模态模型配 profile；DeepSeek 等纯文本模型标 vision: false）
              </span>
            ) : null}
            {canStyle ? (
              <button type="button" className="btn" onClick={() => setTab("style")}>
                查看已匹配风格 →
              </button>
            ) : null}
            <span className="text-[12px] text-[var(--muted)]">
              第一步只匹配风格、不花钱生图，可以反复重来
            </span>
          </div>
        </div>
      ) : null}

      {/* ───────── ② 风格（可编辑 + 样张）───────── */}
      {tab === "style" && style ? (
        <div className="space-y-4">
          <StyleEditor style={style} onChange={setStyle} />

          <StyleTestImage
            style={style}
            imageProfiles={profiles.image}
            imageProfileId={imageProfileId}
            onProfileChange={setImageProfileId}
          />

          <div className="panel p-4">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <div>
                <label className="mb-1.5 block text-[12px] text-[var(--muted)]">
                  不满意？补充调整要求后点「换一套」（可留空直接换）
                </label>
                <input
                  className="field"
                  placeholder="例如：更冷一点、少点霓虹、整体更高级克制"
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--muted)]">镜数</span>
                  <input
                    type="number"
                    className="field mono w-20"
                    min={1}
                    max={24}
                    value={shotCount}
                    onChange={(e) => setShotCount(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                  />
                </div>
                <button type="button" className="btn" disabled={loading === "style"} onClick={() => genStyle(adjustNote)}>
                  {loading === "style" ? "重算中…" : "换一套"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={loading === "shots" || !profiles.text.length}
                  onClick={genShots}
                >
                  {loading === "shots" ? "写分镜中…" : `用这个风格写 ${shotCount} 镜 →`}
                </button>
              </div>
            </div>
            <p className="mt-3 text-[11.5px] text-[var(--muted)]">
              提示：上方风格字段可直接编辑；改完点「用这个风格写分镜」会用当前（含你改动后的）风格生成分镜。
            </p>
          </div>
        </div>
      ) : null}

      {/* ───────── ③ 分镜（可编辑 + 中英）───────── */}
      {tab === "shots" && storyboard && style ? (
        <div className="space-y-4">
          {/* R1.2：输入在生成之后被改过 —— 继续往下走会把配额烧在过期的分镜上 */}
          {inputDrifted ? (
            <div className="panel p-4" style={{ borderColor: "var(--err)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold" style={{ color: "var(--err)" }}>
                  输入已变更：当前分镜对应的是改动前的输入
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <button type="button" className="btn" onClick={() => setTab("input")}>
                    回输入 tab
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={loading !== ""}
                    onClick={() => void genShots()}
                  >
                    用新输入重新生成分镜
                  </button>
                </span>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
                接着给这批分镜生关键帧、生视频，产物会对不上新输入，配额照样要花。要么重新生成分镜，
                要么把输入改回去 —— 两边指纹一致时本条自动消失。
              </p>
            </div>
          ) : null}

          {/* 生成进度 / 失败重试面板 */}
          {progress.phase !== "" || failedShots.length ? (
            <div className="panel p-4">
              {progress.phase !== "" ? (
                <>
                  <div className="mb-2 flex items-center justify-between text-[12.5px]">
                    <span className="font-medium">{progress.last || "生成中…"}</span>
                    <span className="mono text-[var(--muted)]">
                      {progress.phase === "outline" ? "大纲" : `${progress.done}/${progress.total} 镜`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 8}%`,
                        background: "var(--accent)",
                      }}
                    />
                  </div>
                  <p className="mt-2 text-[11.5px] text-[var(--muted)]">
                    两段式生成：先出大纲（快），再逐镜展开（每镜约 10-40s，完成一镜显示一镜，失败只重试单镜）
                  </p>
                </>
              ) : null}
              {failedShots.length ? (
                <div className={progress.phase !== "" ? "mt-3 border-t border-[var(--border)] pt-3" : ""}>
                  <div className="mb-2 text-[12.5px] font-medium" style={{ color: "var(--err)" }}>
                    {failedShots.length} 镜生成失败（其余镜不受影响），可单独重试：
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {failedShots.map((i) => (
                      <button key={i} type="button" className="btn" disabled={progress.phase !== ""} onClick={() => retryShot(i)}>
                        重试第 {i} 镜
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold">{storyboard.meta.title || "广告分镜脚本"}</h2>
              <span className="chip">{style.name_zh}</span>
              <span className="chip mono">{storyboard.meta.aspect_ratio}</span>
              <span className="chip mono">
                目标 {storyboard.meta.target_duration}s · 实际{" "}
                {formatTimecode(storyboard.shots.reduce((a, s) => a + s.duration, 0))}
              </span>
              <span className="chip mono">{storyboard.shots.length} 镜</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
              <CopyButton text={allImagePrompts(storyboard)} label="复制全部图像 Prompt(EN)" variant="solid" />
              <CopyButton text={allVideoPrompts(storyboard, storyboard.global_negative)} label="复制全部视频 Prompt(EN)" />
              <CopyButton text={toMarkdown(storyboard, style)} label="复制 Markdown(含中文)" />
              <CopyButton text={bundleAll(storyboard, style)} label="复制 JSON" />
              <button
                type="button"
                className="btn"
                onClick={() => download("storyboard.md", toMarkdown(storyboard, style), "text/markdown")}
              >
                下载 .md
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => download("storyboard.json", bundleAll(storyboard, style), "application/json")}
              >
                下载 .json
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  download(
                    "storyboard-whole.txt",
                    wholeVideoPrompt(storyboard, style, { entities: outline?.entities }),
                    "text/plain"
                  )
                }
              >
                下载整片 .txt
              </button>
              <button
                type="button"
                className="btn"
                disabled={archiving}
                onClick={() => void handleArchive()}
                title="把成片 mp4、关键帧图与 prompt 落到 .data/artifacts/ —— 不依赖上游链接是否还在"
              >
                {archiving ? "归档中…" : "归档到本地"}
              </button>
            </div>

            {archiveResult ? (
              <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium" style={{ color: "var(--accent)" }}>
                    已归档 {archiveResult.written.length} 个文件 · {fmtBytes(archiveResult.totalBytes)}
                  </span>
                  <CopyButton text={archiveResult.dir} label="复制路径" />
                  <button type="button" className="btn ml-auto" onClick={() => setArchiveResult(null)}>
                    收起
                  </button>
                </div>
                <div className="mono mt-1.5 text-[11px] break-all text-[var(--muted)]">{archiveResult.dir}</div>
                <ul className="mt-2 space-y-0.5">
                  {archiveResult.written.map((f) => (
                    <li key={f.name} className="flex items-center gap-2 text-[11.5px]">
                      <span className="mono">{f.name}</span>
                      <span className="text-[var(--muted)]">{fmtBytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
                {archiveResult.failed.length ? (
                  <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--err)" }}>
                    {archiveResult.failed.length} 项没拿到：
                    {archiveResult.failed.map((f) => `${f.name}（${f.reason}）`).join("；")}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {consistencyNotes.length ? (
            <div className="panel p-4">
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium" style={{ color: "var(--accent)" }}>
                跨镜一致性锁定 · 生图/生视频时必须逐字沿用
                <span className="text-[11px] font-normal text-[var(--muted)]">（每行一条，可编辑）</span>
              </div>
              <textarea
                className="field mono text-[13px]"
                rows={Math.max(2, consistencyNotes.length)}
                value={consistencyNotes.join("\n")}
                onChange={(e) =>
                  setConsistencyNotes(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))
                }
              />
            </div>
          ) : null}

          {/* ── 视频生成：全局设置（profile 选择 + 配额说明 + 错误提示） ── */}
          {keyframeEnabled && shots?.length ? (
            <div className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">闸门 2 · 关键帧</span>
                <span className="text-[11.5px] text-[var(--muted)]">
                  先给每镜出一张首帧图，再走图生视频 —— 首帧锁住主体外观与构图，跨镜一致性才有锚点
                </span>
                <span className="chip mono text-[11px]">
                  {keyframeDone} / {shots.length} 已就位
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--muted)]">图片 LLM</span>
                <select
                  className="field mono w-64"
                  value={imageProfileId}
                  onChange={(e) => setImageProfileId(e.target.value)}
                >
                  {profiles.image.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="chip mono text-[11px]">{kfSize}</span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={keyframeAnyBusy || keyframeMissing === 0}
                  onClick={() => void handleGenerateAllKeyframes()}
                >
                  {keyframeAnyBusy
                    ? `生成中… 还有 ${keyframePending} 张`
                    : keyframeMissing === 0
                      ? "全部关键帧已就位"
                      : `一键补齐关键帧（缺 ${keyframeMissing} 镜）`}
                </button>
              </div>
              <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--muted)]">
                串行逐张生成（并发会被图接口限流）。首帧图会作为 <code className="mono text-[var(--text)]">first_frame</code>{" "}
                传给视频接口，视频自动切到 <code className="mono text-[var(--text)]">keyframe</code> 模式；未生成首帧的分镜仍可走纯文生视频。
              </div>
            </div>
          ) : null}

          <div className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">视频生成</span>
              <span className="text-[11.5px] text-[var(--muted)]">
                异步任务：点分镜里的「生成视频」建任务，之后由服务端按配额自动轮询查询
              </span>
            </div>
            {videoEnabled ? (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-[var(--muted)]">视频 LLM</span>
                  <select
                    className="field mono w-64"
                    value={videoProfileId}
                    onChange={(e) => setVideoProfileId(e.target.value)}
                  >
                    {profiles.video.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="chip mono text-[11px]">
                    {profiles.video.find((p) => p.id === videoProfileId)?.provider ?? "—"}
                  </span>
                </div>
                <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--muted)]">
                  <strong>生成</strong>受配额限制（免费档约 1 次/分钟，全账户共用，所以所有分镜的按钮会一起冷却）；
                  <strong>查询</strong>不受限，建完任务后 1–2 秒就能开始看到进度。
                </div>
                {videoError ? (
                  <div className="mt-2 text-[12px]" style={{ color: "var(--err)" }}>
                    {videoError}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12.5px] leading-relaxed text-[var(--muted)]">
                尚未配置视频 LLM。在项目根目录 <code className="mono text-[var(--text)]">llm.config.json</code> 的{" "}
                <code className="mono text-[var(--text)]">video</code> 组加入一条 profile
                （baseURL / apiKey / model，建议补 <code className="mono text-[var(--text)]">provider</code>
                ，Agnes 用 <code className="mono text-[var(--text)]">&quot;agnes&quot;</code>），保存后刷新页面。
              </div>
            )}
          </div>

          <Timeline
            shots={storyboard.shots}
            onPick={(i) =>
              document.getElementById(`shot-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />

          {storyboard.shots.map((s) => (
            <ShotRow
              key={s.index}
              shot={s}
              aspectRatio={storyboard.meta.aspect_ratio}
              globalNegative={globalNegative}
              globalNegativeCn={globalNegativeCn}
              onShot={(next) => patchShot(s.index, next)}
              videoEnabled={videoEnabled}
              videoTask={videoTasks[s.index]}
              videoBusy={videoBusy}
              videoCreateReadyAt={videoCreateReadyAt}
              keyframeEnabled={keyframeEnabled}
              keyframeBusy={keyframeBusyMap[s.index] ?? false}
              keyframeError={keyframeErrorMap[s.index]}
              onCreateVideo={(payload) => handleCreateVideo(s.index, payload)}
              onRemoveVideo={() => removeVideoTask(s.index)}
              onRefreshVideo={() => refreshVideoTask(s.index)}
              onGenerateKeyframe={(prompt) => void handleGenerateKeyframe(s.index, prompt)}
              onClearKeyframe={() => handleClearKeyframe(s.index)}
            />
          ))}

          <div className="flex flex-wrap items-center gap-2 pb-8">
            <button type="button" className="btn btn-primary" disabled={loading === "shots"} onClick={genShots}>
              {loading === "shots" ? "重写中…" : "重新生成分镜"}
            </button>
            <span className="text-[12px] text-[var(--muted)]">
              · 用当前确认的风格重新生成（保留手工改的会丢失）
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" className="btn" onClick={() => setTab("style")}>
                ← 回风格
              </button>
              <button type="button" className="btn" onClick={() => setTab("input")}>
                ← 回需求
              </button>
              <button
                type="button"
                className="btn"
                onClick={resetAll}
                title="清空本地保存的需求 / 风格 / 分镜，回到空白页"
              >
                清空进度
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* ───────── 生成进度弹窗：锁定页面，防止生成期间误触 ───────── */}
      <ProgressModal
        open={loading === "style" || progress.phase !== ""}
        kind={loading === "style" ? "style" : progress.phase}
        done={progress.done}
        total={progress.total}
        message={progress.last}
        onCancel={() => abortRef.current?.abort()}
      />
    </main>
  );
}
