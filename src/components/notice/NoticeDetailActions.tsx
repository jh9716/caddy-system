"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NoticeDetailActions({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    setBusy(true);
    const res = await fetch(`/api/notice/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    setBusy(false);
    if (!res.ok) {
      alert("삭제 실패");
      return;
    }
    router.replace("/notice");
  }

  return (
    <div className="notice-detail-actions">
      <a href={`/notice/${id}/edit`} className="ui-btn ui-btn-ghost">
        수정
      </a>
      <button
        type="button"
        onClick={() => void onDelete()}
        disabled={busy}
        className="ui-btn ui-btn-danger"
      >
        {busy ? "삭제 중…" : "삭제"}
      </button>
    </div>
  );
}
