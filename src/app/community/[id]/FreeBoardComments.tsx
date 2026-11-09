"use client";

import { useMemo, useState } from "react";
import type { FreeBoardCommentPublic } from "@/lib/freeBoardComments";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import { liveCommentCount } from "@/lib/boardCommentsState";
import CommentThreadPanel from "@/components/comments/CommentThreadPanel";

export default function FreeBoardComments({
  postId,
  initialComments,
  canCompose,
}: {
  postId: number;
  initialComments: FreeBoardCommentPublic[];
  canCompose: boolean;
}) {
  const [comments, setComments] = useState(initialComments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveCount = useMemo(() => liveCommentCount(comments), [comments]);
  const base = `/api/free-board/${postId}/comments`;

  async function reload() {
    const res = await fetch(base, { credentials: "include", cache: "no-store" }).catch(() => null);
    if (!res) return;
    if (consumeUnauthorizedMemberResponse(res) || !res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (Array.isArray(data.comments)) setComments(data.comments as FreeBoardCommentPublic[]);
  }

  async function onCreate(body: string, parentId: number | null): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(base, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parentId != null ? { body, parentId } : { body }),
      });
    } catch {
      setBusy(false);
      setError("네트워크 오류로 등록하지 못했습니다.");
      return false;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 등록 실패");
      return false;
    }
    if (data.comment) setComments((cur) => [...cur, data.comment as FreeBoardCommentPublic]);
    void reload();
    return true;
  }

  async function onEdit(id: number, editingBody: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editingBody }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setError("네트워크 오류로 수정하지 못했습니다.");
      return false;
    }
    if (consumeUnauthorizedMemberResponse(res)) return false;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 수정 실패");
      return false;
    }
    if (data.comment) setComments((cur) => cur.map((c) => (c.id === id ? data.comment : c)));
    return true;
  }

  async function onDelete(id: number): Promise<boolean> {
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`${base}/${id}`, { method: "DELETE", credentials: "include" });
    } catch {
      setBusy(false);
      setError("네트워크 오류로 삭제하지 못했습니다.");
      return false;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return false;
    }
    setBusy(false);
    if (!res.ok) {
      setError("댓글 삭제 실패");
      return false;
    }
    setComments((cur) =>
      cur.map((c) =>
        c.id === id
          ? {
              ...c,
              deleted: true,
              body: null,
              authorDisplayName: null,
              authorUserId: null,
              canDelete: false,
              canEdit: false,
            }
          : c
      )
    );
    void reload();
    return true;
  }

  return (
    <CommentThreadPanel
      comments={comments}
      canCompose={canCompose}
      busy={busy}
      error={error}
      liveCount={liveCount}
      onCreate={onCreate}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}
