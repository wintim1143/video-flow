"use client";

import { useState } from "react";

export function CopyButton({
  text,
  label = "复制",
  variant = "ghost",
  title,
}: {
  text: string;
  label?: string;
  variant?: "ghost" | "solid";
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文 / 无权限时的降级路径
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title ?? label}
      className={`btn ${variant === "solid" ? "btn-primary" : ""}`}
      style={
        copied
          ? { borderColor: "var(--ok)", color: "var(--ok)" }
          : undefined
      }
    >
      {copied ? "已复制" : label}
    </button>
  );
}
