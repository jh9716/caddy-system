"use client";

import { useState } from "react";
import type { CommentPublic } from "@/lib/comment";
import { COMMENT_BODY_MAX, COMMENT_DELETED_PLACEHOLDER } from "@/lib/commentConstants";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export default function FreeBoardComments({
  postId,
  initialComments,
  canCompose,
}: {
  postId: number;
  initialComments: CommentPublic[];
  canCompose: boolean;
}) {
  const [comments, setComments] = useState(initialComments);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveCount = comments.filter((c) => !c.deleted).length;
  const base = `/api/free-board/${postId}/comments`;

  async function reload() {
    const res = await fetch(base, { credentials: "include", cache: "no-store" });
    if (consumeUnauthorizedMemberResponse(res) || !res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (Array.isArray(data.comments)) setComments(data.comments as CommentPublic[]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(base, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 등록 실패");
      return;
    }
    if (data.comment) setComments((cur) => [...cur, data.comment as CommentPublic]);
    setBody("");
    void reload();
  }

  async function onDelete(id: number) {
    if (!confirm("이 댓글을 삭제할까요?")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/${id}`, { method: "DELETE", credentials: "include" });
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      setError("댓글 삭제 실패");
      return;
    }
    setComments((cur) =>
      cur.map((c) =>
        c.id === id
          ? { ...c, deleted: true, body: null, authorDisplayName: null, authorUserId: null, canDelete: false }
          : c
      )
    );
    void reload();
  }

  return (
    <section className="course-report-comments board-comments" aria-label="댓글">
      <h2 className="course-report-comments-title">댓글 {liveCount}</h2>
      {error ? (
        <p className="free-board-error" role="alert">
          {error}
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="board-comments-empty">등록된 댓글이 없습니다.</p>
      ) : (
        <ul className="course-report-comment-list">
          {comments.map((item) => (
            <li key={item.id} className={`course-report-comment${item.deleted ? " is-deleted" : ""}`}>
              {item.deleted ? (
                <p className="course-report-comment-deleted">{COMMENT_DELETED_PLACEHOLDER}</p>
              ) : (
                <>
                  <div className="course-report-comment-meta">
                    <span className="course-report-comment-author">{item.authorDisplayName}</span>
                    <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
                    {item.canDelete ? (
                      <button
                        type="button"
                        className="course-report-comment-delete free-board-touch"
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
      )}
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
            disabled={busy || !body.trim()}
          >
            {busy ? "등록 중…" : "등록"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
