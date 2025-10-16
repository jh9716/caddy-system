"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  id: number;
  initialTitle: string;
  initialContent: string;
  canEdit: boolean;
};

export default function NoticeActions({
  id,
  initialTitle,
  initialContent,
  canEdit,
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);

  if (!canEdit) {
    return null;
  }

  async function onSave() {
    try {
      setSaving(true);
      const res = await fetch(`/api/notice/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // content, body 둘 다 보내서 백엔드 어떤 필드여도 수용되게
        body: JSON.stringify({ title, content, body: content }),
      });
      if (!res.ok) throw new Error("failed");
      setEditing(false);
      router.refresh();
    } catch {
      alert("수정에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    const res = await fetch(`/api/notice/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("삭제에 실패했습니다.");
      return;
    }
    router.push("/notice");
  }

  return (
    <div style={{ display: "flex", gap: 8 }}>
      {!editing ? (
        <>
          <button
            onClick={() => setEditing(true)}
            style={btn("ghost")}
            aria-label="공지 수정"
          >
            수정
          </button>
          <button onClick={onDelete} style={btn("danger")} aria-label="공지 삭제">
            삭제
          </button>
        </>
      ) : (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            padding: 12,
            minWidth: 320,
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="제목"
              style={input()}
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="내용"
              rows={6}
              style={textarea()}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setEditing(false);
                  setTitle(initialTitle);
                  setContent(initialContent);
                }}
                style={btn("ghost")}
              >
                취소
              </button>
              <button onClick={onSave} disabled={saving} style={btn("primary")}>
                {saving ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ——— 작은 스타일 유틸 ——— */
function btn(variant: "primary" | "ghost" | "danger") {
  const base: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
  };
  if (variant === "primary") {
    return { ...base, background: "#0f172a", color: "#fff", borderColor: "#0f172a" };
  }
  if (variant === "danger") {
    return { ...base, background: "#fee2e2", color: "#991b1b", borderColor: "#fecaca" };
  }
  return base;
}

function input(): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    outline: "none",
  };
}

function textarea(): React.CSSProperties {
  return {
    ...input(),
    resize: "vertical",
    lineHeight: 1.6,
  };
}
