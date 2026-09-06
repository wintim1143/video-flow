"use client";

import { useCallback, useEffect, useState } from "react";
import type { AspectRatio, Shot, Storyboard, StyleSpec } from "@/lib/schema";
import { ASPECT_LABEL, formatTimecode } from "@/lib/schema";
import { allImagePrompts, allVideoPrompts, bundleAll, toMarkdown } from "@/lib/exports";
import type { LlmConfigsResponse, LlmProfileSafe } from "@/lib/llm-types";
import { StyleEditor } from "@/components/StyleEditor";
import { StyleTestImage } from "@/components/StyleTestImage";
import { Timeline } from "@/components/Timeline";
import { ShotRow } from "@/components/ShotRow";
import { CopyButton } from "@/components/CopyButton";

type Tab = "input" | "style" | "shots";
type ApiError = { code: string; message: string; detail?: string };

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

const DURATION_PRESETS = [15, 30, 60];

function suggestShotCount(targetDuration: number): number {
  return Math.min(24, Math.max(2, Math.round(targetDuration / 5)));
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

export default function Page() {
  const [tab, setTab] = useState<Tab>("input");
  const [brief, setBrief] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [targetDuration, setTargetDuration] = useState(30);
  const [shotCount, setShotCount] = useState(suggestShotCount(30));
  const [adjustNote, setAdjustNote] = useState("");

  const [style, setStyle] = useState<StyleSpec | null>(null);
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [sbMeta, setSbMeta] = useState<Storyboard["meta"] | null>(null);
  const [globalNegative, setGlobalNegative] = useState("");
  const [globalNegativeCn, setGlobalNegativeCn] = useState("");
  const [consistencyNotes, setConsistencyNotes] = useState<string[]>([]);

  const [loading, setLoading] = useState<"" | "style" | "shots">("");
  const [error, setError] = useState<ApiError | null>(null);

  // ── LLM profiles（脱敏，来自 /api/llm-configs）──
  const [profiles, setProfiles] = useState<LlmConfigsResponse>({ text: [], image: [], video: [] });
  const [textProfileId, setTextProfileId] = useState("");
  const [imageProfileId, setImageProfileId] = useState("");

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
      })
      .catch(() => {
        /* 配置读取失败不阻塞页面，生成时会报具体错误 */
      });
  }, []);

  // ── tabs 可用性：有数据才开放切换 ──
  const canStyle = !!style;
  const canShots = !!shots && !!style;
  const tabs: Array<{ key: Tab; label: string; disabled: boolean }> = [
    { key: "input", label: "① 需求", disabled: false },
    { key: "style", label: "② 风格", disabled: !canStyle },
    { key: "shots", label: "③ 分镜", disabled: !canShots },
  ];

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

  async function genStyle(adjust?: string) {
    if (!brief.trim()) {
      setError({ code: "BAD_INPUT", message: "请先填写广告需求描述" });
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
    try {
      const payload = {
        brief: adjust?.trim() ? `${brief}\n\n【风格调整要求】${adjust.trim()}` : brief,
        aspectRatio,
        targetDuration,
        profileId: textProfileId || undefined,
      };
      const res = await fetch("/api/style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      setError({ code: "NETWORK", message: "请求失败，请确认 dev server 在运行", detail: String(e) });
    } finally {
      setLoading("");
    }
  }

  async function genShots() {
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
    try {
      const res = await fetch("/api/shots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, aspectRatio, targetDuration, style, shotCount, profileId: textProfileId || undefined }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError({ code: json.code, message: json.message, detail: json.detail });
        return;
      }
      const sb = json.data as Storyboard;
      setShots(sb.shots);
      setSbMeta(sb.meta);
      setGlobalNegative(sb.global_negative);
      setGlobalNegativeCn(sb.global_negative ?? "");
      setConsistencyNotes(sb.consistency_notes);
      setTab("shots");
    } catch (e) {
      setError({ code: "NETWORK", message: "请求失败，请确认 dev server 在运行", detail: String(e) });
    } finally {
      setLoading("");
    }
  }

  const storyboard = canShots ? buildStoryboard() : null;

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

        {/* 文本 LLM 切换（风格/分镜生成共用） */}
        <div className="flex items-center gap-1.5" title="用于生成风格与分镜的文本 LLM">
          <span className="text-[11px] text-[var(--muted)]">文本LLM</span>
          <select
            className="field mono w-44"
            value={textProfileId}
            onChange={(e) => setTextProfileId(e.target.value)}
            disabled={!profiles.text.length}
          >
            {profiles.text.length ? (
              profiles.text.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            ) : (
              <option value="">未配置</option>
            )}
          </select>
        </div>
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

          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-[12px] text-[var(--muted)]">示例：</span>
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="btn" onClick={() => setBrief(ex.text)}>
                {ex.label}
              </button>
            ))}
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
                    const v = Number(e.target.value) || 30;
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
              disabled={loading === "style" || !brief.trim() || !profiles.text.length}
              onClick={() => genStyle()}
            >
              {loading === "style" ? "匹配风格中…" : "匹配风格 →"}
            </button>
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
            </div>
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
              globalNegative={globalNegative}
              globalNegativeCn={globalNegativeCn}
              onShot={(next) => patchShot(s.index, next)}
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
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
