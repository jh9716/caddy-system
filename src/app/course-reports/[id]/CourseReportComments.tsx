"use client";

import { useMemo, useState } from "react";
import type { CommentPublic } from "@/lib/comment";
import { COMMENT_BODY_MAX, COMMENT_DELETED_PLACEHOLDER } from "@/lib/commentConstants";

function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

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
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const liveCount = useMemo(
    () => comments.filter((c) => !c.deleted).length,
    [comments]
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canCompose) return;
    setBusy(true);
    const res = await fetch(`/api/course-reports/${reportId}/comments`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      alert(typeof data.message === "string" ? data.message : "댓글 등록 실패");
      return;
    }
    if (data.comment) {
      setComments((cur) => [...cur, data.comment as CommentPublic]);
      setBody("");
    }
  }

  async function onDelete(commentId: number) {
    if (!confirm("이 댓글을 삭제할까요?")) return;
    setBusy(true);
    const res = await fetch(
      `/api/course-reports/${reportId}/comments/${commentId}`,
      { method: "DELETE", credentials: "include" }
    );
    setBusy(false);
    if (!res.ok) {
      alert("댓글 삭제 실패");
      return;
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
            }
          : c
      )
    );
  }

  return (
    <section className="course-report-comments" aria-label="댓글">
      <h2 className="course-report-comments-title">댓글 {liveCount}</h2>
      <ul className="course-report-comment-list">
        {comments.map((item) => (
          <li
            key={item.id}
            className={`course-report-comment${item.deleted ? " is-deleted" : ""}`}
          >
            {item.deleted ? (
              <p className="course-report-comment-deleted">
                {COMMENT_DELETED_PLACEHOLDER}
              </p>
            ) : (
              <>
                <div className="course-report-comment-meta">
                  <span className="course-report-comment-author">
                    {item.authorDisplayName}
                  </span>
                  <time dateTime={item.createdAt}>
                    {formatCommentTime(item.createdAt)}
                  </time>
                  {item.canDelete ? (
                    <button
                      type="button"
                      className="course-report-comment-delete"
                      disabled={busy}
                      onClick={() => void onDelete(item.id)}
                    >
                      삭제
                    </button>
                  ) : null}
                </div>
                <p className="course-report-comment-body">{item.body}</p>
              </>
            )}
          </li>
        ))}
      </ul>
      {canCompose ? (
        <form className="course-report-comment-form" onSubmit={(e) => void onSubmit(e)}>
          <textarea
            aria-label="댓글"
            value={body}
            maxLength={COMMENT_BODY_MAX}
            rows={3}
            placeholder="댓글을 입력하세요"
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="submit"
            className="ui-btn ui-btn-primary course-report-comment-submit"
            disabled={busy}
          >
            {busy ? "등록 중…" : "등록"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
