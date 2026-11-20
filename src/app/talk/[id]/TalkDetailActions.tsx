"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import { COMMUNITY_FREE_BOARD_API, COMMUNITY_FREE_BOARD_PATH } from "@/lib/communityBoardConstants";

/** 수정(작성자 본인) · 삭제(작성자 본인 또는 관리자). 서버가 다시 권한을 확인한다. */
export default function TalkDetailActions({
  id,
  canEdit,
  canDelete,
  moderatorOnly,
}: {
  id: number;
  canEdit: boolean;
  canDelete: boolean;
  moderatorOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!canEdit && !canDelete) return null;

  async function onDelete() {
    const msg = moderatorOnly
      ? "관리자 권한으로 이 글을 삭제할까요? 사진과 댓글도 함께 보이지 않게 됩니다."
      : "이 글을 삭제할까요? 사진과 댓글도 함께 보이지 않게 됩니다.";
    if (!confirm(msg)) return;
    setBusy(true);
    setError("");
    let res: Response;
    try {
      res = await fetch(`${COMMUNITY_FREE_BOARD_API}/${id}`, { method: "DELETE", credentials: "include" });
    } catch {
      setBusy(false);
      setError("네트워크 오류로 삭제하지 못했습니다.");
      return;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      setError("삭제하지 못했습니다.");
      return;
    }
    router.replace(COMMUNITY_FREE_BOARD_PATH);
    router.refresh();
  }

  return (
    <div className="talk-actions">
      {canEdit ? (
        <a href={`${COMMUNITY_FREE_BOARD_PATH}/${id}/edit`} className="ui-btn ui-btn-ghost talk-touch">
          수정
        </a>
      ) : null}
      {canDelete ? (
        <button type="button" className="ui-btn ui-btn-danger talk-touch" disabled={busy} onClick={() => void onDelete()}>
          {moderatorOnly ? "관리자 삭제" : "삭제"}
        </button>
      ) : null}
      {error ? <p className="free-board-error" role="alert">{error}</p> : null}
    </div>
  );
}
