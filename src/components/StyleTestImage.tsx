"use client";

import { useEffect, useMemo, useState } from "react";
import type { StyleSpec } from "@/lib/schema";
import { EditableText } from "./EditableText";
import type { LlmProfileSafe } from "@/lib/llm-types";

const SIZES = [
  { value: "1024x1536", label: "竖 1024×1536" },
  { value: "1024x1024", label: "方 1024×1024" },
  { value: "1536x1024", label: "横 1536×1024" },
] as const;

type Size = (typeof SIZES)[number]["value"];

/** 由风格规格拼一张「风格样张」的默认 prompt（可编辑） */
export function buildStyleTestPrompt(style: StyleSpec): string {
  const parts = [
    "Hero product shot for a premium advertisement, single product centered with generous negative space.",
    style.keywords_en.join(", ") + ".",
    style.lighting ? `${style.lighting}.` : "",
    style.composition ? `${style.composition}.` : "",
    style.materials ? `Materials: ${style.materials}.` : "",
    style.palette.length ? `Color palette: ${style.palette.join(", ")}.` : "",
    style.negative ? `Avoid: ${style.negative}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * 风格样张：手动触发一次图片生成，用于在写分镜前确认视觉方向。
 * 无图片 LLM 配置时整块降级为配置指引。
 */
export function StyleTestImage({
  style,
  imageProfiles,
  imageProfileId,
  onProfileChange,
}: {
  style: StyleSpec;
  imageProfiles: LlmProfileSafe[];
  imageProfileId: string;
  onProfileChange: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState(() => buildStyleTestPrompt(style));
  const [touched, setTouched] = useState(false);
  const [size, setSize] = useState<Size>("1024x1024");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  // 生成结果：b64 可直接 img src，url 直接挂 src
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgMeta, setImgMeta] = useState<string>("");

  // 风格变化（换一套/编辑关键字段）且用户未手改过 prompt 时，自动跟随重置
  useEffect(() => {
    if (!touched) setPrompt(buildStyleTestPrompt(style));
  }, [style, touched]);

  const noImageLlm = imageProfiles.length === 0;
  const currentName = useMemo(
    () => imageProfiles.find((p) => p.id === imageProfileId)?.name ?? "",
    [imageProfiles, imageProfileId]
  );

  async function generate() {
    setLoading(true);
    setError(null);
    setImgSrc(null);
    try {
      const res = await fetch("/api/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: imageProfileId || undefined, prompt, size }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError({ message: json.message, detail: json.detail });
        return;
      }
      const d = json.data as { kind: "b64" | "url"; data?: string; url?: string; model: string };
      setImgSrc(d.kind === "b64" ? `data:image/png;base64,${d.data}` : (d.url as string));
      setImgMeta(`${d.model} · ${size}`);
    } catch (e) {
      setError({ message: "请求失败，请确认 dev server 在运行", detail: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">风格样张 · 生图确认</h3>
        <span className="text-[11.5px] text-[var(--muted)]">
          写分镜前先出一张图确认视觉方向，避免整套分镜跑偏
        </span>
      </div>

      {noImageLlm ? (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12.5px] leading-relaxed text-[var(--muted)]">
          尚未配置图片 LLM。在项目根目录 <code className="mono text-[var(--text)]">llm.config.json</code> 的{" "}
          <code className="mono text-[var(--text)]">image</code> 组加入一条 profile（baseURL / apiKey / model，
          OpenAI 兼容 <code className="mono text-[var(--text)]">/images/generations</code> 协议），保存后刷新页面即可在此生成。
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-[var(--muted)]">图片 LLM</span>
            <select
              className="field mono w-64"
              value={imageProfileId}
              onChange={(e) => onProfileChange(e.target.value)}
            >
              {imageProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {currentName ? <span className="chip mono text-[11px]">{currentName}</span> : null}
            <span className="ml-2 text-[12px] text-[var(--muted)]">尺寸</span>
            <div className="flex gap-1">
              {SIZES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className="btn"
                  onClick={() => setSize(s.value)}
                  style={size === s.value ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] text-[var(--muted)]">
                样张 prompt（已按当前风格预填，可改成任意你想确认的画面）
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTouched(false);
                  setPrompt(buildStyleTestPrompt(style));
                }}
              >
                按当前风格重置
              </button>
            </div>
            <EditableText
              value={prompt}
              onCommit={(v) => {
                setTouched(true);
                setPrompt(v);
              }}
              mono
              rows={4}
            />
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={loading || !prompt.trim()} onClick={generate}>
              {loading ? "生成中…" : "生成样张"}
            </button>
            {error ? (
              <span className="text-[12.5px]" style={{ color: "var(--err)" }}>
                {error.message}
              </span>
            ) : null}
          </div>
          {error?.detail ? (
            <pre className="prompt-box mono mt-2 max-h-32 overflow-auto text-[11px] text-[var(--muted)]">
              {error.detail}
            </pre>
          ) : null}

          {imgSrc ? (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="chip mono text-[11px]">{imgMeta}</span>
                <a className="btn" href={imgSrc} download="style-test.png">
                  下载
                </a>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc}
                alt="风格样张"
                className="max-h-[480px] w-auto rounded-md border border-[var(--border)]"
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
