"use client";

import { useMemo, useState } from "react";
import type { CommentPublic } from "@/lib/comment";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import { liveCommentCount } from "@/lib/boardCommentsState";
import CommentThreadPanel from "@/components/comments/CommentThreadPanel";

export default function CourseReportComments({
  reportId,
  initialComments,
  canCompose,
}: {
  reportId: number;
  initialComments: CommentPublic[];
  canCompose: boolean;
}) {
  const [comments, setComments] = useState(initialComments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveCount = useMemo(() => liveCommentCount(comments), [comments]);
  const base = `/api/course-reports/${reportId}/comments`;

  async function onCreate(body: string, parentId: number | null): Promise<boolean> {
    if (busy || !canCompose) return false;
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
    if (data.comment) {
      setComments((cur) => [...cur, data.comment as CommentPublic]);
    }
    return true;
  }

  async function onEdit(commentId: number, body: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`${base}/${commentId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    } catch {
      setBusy(false);
      setError("네트워크 오류로 수정하지 못했습니다.");
      return false;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 수정 실패");
      return false;
    }
    if (data.comment) {
      setComments((cur) => cur.map((c) => (c.id === commentId ? (data.comment as CommentPublic) : c)));
    }
    return true;
  }

  async function onDelete(commentId: number): Promise<boolean> {
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`${base}/${commentId}`, { method: "DELETE", credentials: "include" });
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
        c.id === commentId
          ? {
              ...c,
              deleted: true,
              authorUserId: null,
              authorDisplayName: null,
              body: null,
              canDelete: false,
              canEdit: false,
            }
          : c
      )
    );
    return true;
  }

  return (
    <CommentThreadPanel
      comments={comments}
      canCompose={canCompose}
      busy={busy}
      error={error}
      liveCount={liveCount}
      sectionClassName="course-report-comments"
      onCreate={onCreate}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}
