"use client";

import { Fragment, useMemo, useState } from "react";
import type { CommentPublic } from "@/lib/comment";
import { COMMENT_BODY_MAX, COMMENT_DELETED_PLACEHOLDER } from "@/lib/commentConstants";
import { groupCommentsForDisplay } from "@/lib/comment";

function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export default function CommentThreadPanel({
  comments,
  canCompose,
  busy,
  error,
  liveCount,
  sectionClassName = "course-report-comments board-comments",
  dateAttr,
  onCreate,
  onEdit,
  onDelete,
}: {
  comments: CommentPublic[];
  canCompose: boolean;
  busy: boolean;
  error: string | null;
  liveCount: number;
  sectionClassName?: string;
  dateAttr?: string;
  onCreate: (body: string, parentId: number | null) => Promise<boolean>;
  onEdit: (commentId: number, body: string) => Promise<boolean>;
  onDelete: (commentId: number) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const groups = useMemo(() => groupCommentsForDisplay(comments), [comments]);
  const shownError = localError ?? error;

  function startEdit(item: CommentPublic) {
    setEditingId(item.id);
    setEditBody(item.body ?? "");
    setReplyingTo(null);
    setReplyBody("");
    setLocalError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
  }

  function startReply(item: CommentPublic) {
    setReplyingTo(item.id);
    setReplyBody("");
    setEditingId(null);
    setEditBody("");
    setLocalError(null);
  }

  function cancelReply() {
    setReplyingTo(null);
    setReplyBody("");
  }

  async function submitTop(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canCompose) return;
    if (!body.trim()) {
      setLocalError("댓글을 입력해 주세요.");
      return;
    }
    setLocalError(null);
    const ok = await onCreate(body, null);
    if (ok) setBody("");
  }

  async function submitReply(parentId: number) {
    if (busy || !canCompose) return;
    if (!replyBody.trim()) {
      setLocalError("댓글을 입력해 주세요.");
      return;
    }
    setLocalError(null);
    const ok = await onCreate(replyBody, parentId);
    if (ok) cancelReply();
  }

  async function saveEdit(commentId: number) {
    if (busy) return;
    if (!editBody.trim()) {
      setLocalError("댓글을 입력해 주세요.");
      return;
    }
    setLocalError(null);
    const ok = await onEdit(commentId, editBody);
    if (ok) cancelEdit();
  }

  async function remove(commentId: number) {
    if (!confirm("이 댓글을 삭제할까요?")) return;
    setLocalError(null);
    const ok = await onDelete(commentId);
    if (ok) {
      setEditingId((cur) => (cur === commentId ? null : cur));
      setReplyingTo((cur) => (cur === commentId ? null : cur));
    }
  }

  function renderItem(item: CommentPublic, isReply: boolean) {
    return (
      <li
        key={item.id}
        className={`course-report-comment${item.deleted ? " is-deleted" : ""}${
          isReply ? " is-reply" : ""
        }`}
        data-comment-id={item.id}
        data-parent-id={item.parentId ?? ""}
      >
        {item.deleted ? (
          <p className="course-report-comment-deleted">{COMMENT_DELETED_PLACEHOLDER}</p>
        ) : (
          <>
            <div className="course-report-comment-meta">
              <span className="course-report-comment-author">{item.authorDisplayName}</span>
              <time dateTime={item.createdAt}>{formatCommentTime(item.createdAt)}</time>
              {item.edited ? <span className="board-comment-edited">(수정됨)</span> : null}
              {editingId !== item.id ? (
                <span className="board-comment-actions">
                  {canCompose ? (
                    <button
                      type="button"
                      className="course-report-comment-delete board-comment-action"
                      disabled={busy}
                      onClick={() => startReply(item)}
                    >
                      답글
                    </button>
                  ) : null}
                  {item.canEdit ? (
                    <button
                      type="button"
                      className="course-report-comment-delete board-comment-action"
                      disabled={busy}
                      onClick={() => startEdit(item)}
                    >
                      수정
                    </button>
                  ) : null}
                  {item.canDelete ? (
                    <button
                      type="button"
                      className="course-report-comment-delete board-comment-action"
                      disabled={busy}
                      onClick={() => void remove(item.id)}
                    >
                      삭제
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {editingId === item.id ? (
              <div className="course-report-comment-form board-comment-edit-form">
                <textarea
                  aria-label="댓글 수정"
                  value={editBody}
                  maxLength={COMMENT_BODY_MAX}
                  rows={3}
                  disabled={busy}
                  onChange={(e) => setEditBody(e.target.value)}
                />
                <div className="board-comment-edit-actions">
                  <span className="board-comment-counter">
                    {editBody.length}/{COMMENT_BODY_MAX}
                  </span>
                  <button type="button" className="ui-btn course-report-comment-submit" disabled={busy} onClick={cancelEdit}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary course-report-comment-submit"
                    disabled={busy}
                    onClick={() => void saveEdit(item.id)}
                  >
                    {busy ? "저장 중…" : "저장"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="course-report-comment-body">{item.body}</p>
            )}
            {replyingTo === item.id ? (
              <div className="course-report-comment-form board-comment-reply-form">
                <textarea
                  aria-label="답글"
                  value={replyBody}
                  maxLength={COMMENT_BODY_MAX}
                  rows={3}
                  disabled={busy}
                  placeholder="답글을 입력하세요"
                  enterKeyHint="enter"
                  onChange={(e) => setReplyBody(e.target.value)}
                />
                <div className="board-comment-edit-actions">
                  <span className="board-comment-counter">
                    {replyBody.length}/{COMMENT_BODY_MAX}
                  </span>
                  <button type="button" className="ui-btn course-report-comment-submit" disabled={busy} onClick={cancelReply}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary course-report-comment-submit"
                    disabled={busy || !replyBody.trim()}
                    onClick={() => void submitReply(item.id)}
                  >
                    {busy ? "등록 중…" : "답글 등록"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </li>
    );
  }

  return (
    <section className={sectionClassName} aria-label="댓글" data-board-date={dateAttr}>
      <h2 className="course-report-comments-title">
        댓글 <span className="board-comments-count">{liveCount}</span>
      </h2>
      {shownError ? (
        <p className="board-comments-error" role="alert">
          {shownError}
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="board-comments-empty">등록된 댓글이 없습니다.</p>
      ) : (
        <ul className="course-report-comment-list">
          {groups.map(({ root, replies }) => (
            <Fragment key={root.id}>
              {renderItem(root, false)}
              {replies.map((reply) => renderItem(reply, true))}
            </Fragment>
          ))}
        </ul>
      )}
      {canCompose ? (
        <form className="course-report-comment-form" onSubmit={(e) => void submitTop(e)}>
          <textarea
            aria-label="댓글"
            value={body}
            maxLength={COMMENT_BODY_MAX}
            rows={3}
            placeholder="댓글을 입력하세요"
            disabled={busy}
            enterKeyHint="enter"
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="board-comment-edit-actions">
            <span className="board-comment-counter">
              {body.length}/{COMMENT_BODY_MAX}
            </span>
            <button
              type="submit"
              className="ui-btn ui-btn-primary course-report-comment-submit"
              disabled={busy || !body.trim()}
            >
              {busy ? "등록 중…" : "등록"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
