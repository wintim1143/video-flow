"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 可编辑多行文本：失焦自动保存；Ctrl/Cmd+Enter 立即保存。
 * 纯受控 UI，不持有数据，值变化通过 onCommit 通知父级。
 */
export function EditableText({
  value,
  onCommit,
  mono,
  placeholder,
  label,
  rows = 3,
}: {
  value: string;
  onCommit: (next: string) => void;
  mono?: boolean;
  placeholder?: string;
  label?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const committedRef = useRef(true);
  // 外部值变化时同步草稿（编辑态下不覆盖以免丢输入）
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function save() {
    if (!committedRef.current && draft !== value) onCommit(draft);
    committedRef.current = true;
    setEditing(false);
  }

  return (
    <textarea
      className={`field w-full ${mono ? "mono" : ""}`}
      value={draft}
      rows={rows}
      placeholder={placeholder ?? label}
      onFocus={() => {
        committedRef.current = true;
        setEditing(true);
      }}
      onChange={(e) => {
        committedRef.current = false;
        setDraft(e.target.value);
      }}
      onBlur={save}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}
