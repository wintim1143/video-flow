"use client";

import type { StyleSpec } from "@/lib/schema";
import { findSeed } from "@/lib/seed-styles";
import { EditableText } from "./EditableText";

const DIM_LABELS: Array<{ key: keyof StyleSpec; label: string; hint?: string }> = [
  { key: "style", label: "风格", hint: "风格总述" },
  { key: "color", label: "色彩", hint: "色调与配色" },
  { key: "lighting", label: "光照", hint: "光位与光质" },
  { key: "composition", label: "构图", hint: "构图法则" },
  { key: "materials", label: "材质", hint: "材质与质感" },
  { key: "motion", label: "运动", hint: "运动语言" },
  { key: "camera", label: "镜头", hint: "镜头语言倾向" },
];

const TEXT_FIELDS: Array<{ key: keyof StyleSpec; label: string; mono?: boolean }> = [
  { key: "name_zh", label: "名称（中）" },
  { key: "name_en", label: "名称（英）" },
  { key: "rationale", label: "选用理由" },
  { key: "negative", label: "负面词", mono: true },
];

/**
 * 可编辑的风格卡。整卡是一份可变的 StyleSpec，通过 onChange 通知父级。
 */
export function StyleEditor({
  style,
  onChange,
}: {
  style: StyleSpec;
  onChange: (next: StyleSpec) => void;
}) {
  const seed = findSeed(style.seed_match);

  function patch(p: Partial<StyleSpec>) {
    onChange({ ...style, ...p });
  }

  return (
    <div className="panel p-5">
      {/* 头：两个名称 + seed 徽标 */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex-1">
          <div className="mb-1 text-[11px] text-[var(--muted)]">风格名称（中文）</div>
          <input
            className="field w-full text-[16px] font-semibold"
            value={style.name_zh}
            onChange={(e) => patch({ name_zh: e.target.value })}
            placeholder="未命名风格"
          />
        </div>
        <div className="w-56">
          <div className="mb-1 text-[11px] text-[var(--muted)]">名称（英文）</div>
          <input
            className="field w-full mono text-[13px]"
            value={style.name_en}
            onChange={(e) => patch({ name_en: e.target.value })}
          />
        </div>
        <span
          className="chip mt-5"
          style={seed ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
        >
          {seed ? `内置风格 · ${seed.name_zh}` : "自由定义"}
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[11px] text-[var(--muted)]">选用理由</div>
        <EditableText
          value={style.rationale}
          onCommit={(v) => patch({ rationale: v })}
          rows={2}
          placeholder="为什么选这套风格"
        />
      </div>

      {/* 色板（可编辑 HEX） */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12px] text-[var(--muted)]">主色板（5 个 HEX，第一个为背景色）</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const next = [...style.palette];
              next.push("#CCCCCC");
              patch({ palette: next.slice(0, 6) });
            }}
          >
            + 加色
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => patch({ palette: style.palette.slice(0, -1) })}
            disabled={!style.palette.length}
          >
            − 删
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {style.palette.map((c, i) => (
            <div key={`${c}-${i}`} className="flex items-center gap-1.5">
              <span
                className="inline-block h-7 w-7 shrink-0 rounded"
                style={{ background: c, border: "1px solid var(--border)" }}
              />
              <input
                className="field mono w-20"
                value={c}
                onChange={(e) => {
                  const next = [...style.palette];
                  next[i] = e.target.value;
                  patch({ palette: next });
                }}
              />
            </div>
          ))}
          {!style.palette.length ? <span className="text-[12px] text-[var(--muted)]">（空）</span> : null}
        </div>
      </div>

      {/* 七维描述 */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {DIM_LABELS.map((d) => (
          <div key={d.key}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-[var(--text)]">{d.label}</span>
              {d.hint ? <span className="text-[10.5px] text-[var(--muted)]">{d.hint}</span> : null}
            </div>
            <EditableText
              value={(style[d.key] as string) ?? ""}
              onCommit={(v) => patch({ [d.key]: v } as Partial<StyleSpec>)}
              placeholder={d.label}
            />
          </div>
        ))}
      </div>

      {/* 英文一致性关键词 */}
      <div className="mt-4">
        <div className="mb-1.5 text-[12px] text-[var(--muted)]">
          英文关键词 · 逐镜 verbatim 复用（跨镜一致性锚点）· 每行一条
        </div>
        <EditableText
          value={style.keywords_en.join("\n")}
          onCommit={(v) =>
            patch({ keywords_en: v.split("\n").map((s) => s.trim()).filter(Boolean) })
          }
          mono
          rows={3}
        />
      </div>
    </div>
  );
}
