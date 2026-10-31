"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

export default function FreeBoardDetailActions({
  id,
  canEdit,
  canDelete,
}: {
  id: number;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!canEdit && !canDelete) return null;

  async function onDelete() {
    if (!confirm("이 글을 삭제할까요?")) return;
    setBusy(true);
    const res = await fetch(`/api/free-board/${id}`, { method: "DELETE", credentials: "include" });
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      alert("삭제 실패");
      return;
    }
    router.replace("/community");
    router.refresh();
  }

  return (
    <div className="course-report-detail-actions">
      {canEdit ? (
        <a href={`/community/${id}/edit`} className="ui-btn ui-btn-ghost">
          수정
        </a>
      ) : null}
      {canDelete ? (
        <button type="button" className="ui-btn ui-btn-danger" disabled={busy} onClick={() => void onDelete()}>
          삭제
        </button>
      ) : null}
    </div>
  );
}
