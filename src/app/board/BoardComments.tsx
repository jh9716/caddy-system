"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentPublic } from "@/lib/comment";
import { COMMENT_BODY_MAX, COMMENT_DELETED_PLACEHOLDER } from "@/lib/commentConstants";
import {
  CLIENT_RESOURCE,
  clientResourceStoreKey,
  ensureClientAuthNamespace,
  peekLastNamespaceResource,
  readLastClientAuthNamespace,
  runDedupedClientResource,
  shouldSkipFreshResourceRefresh,
  writeClientResource,
} from "@/lib/clientResourceCache";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

type CommentsCache = {
  comments: CommentPublic[];
  canCompose: boolean;
};

function rememberComments(date: string, payload: CommentsCache) {
  const ns = readLastClientAuthNamespace();
  if (!ns) return;
  writeClientResource(ns, CLIENT_RESOURCE.BOARD_COMMENTS, date, payload);
}

function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

/**
 * 응답이 현재 선택된 날짜의 것인지 확인 (날짜 전환 중 늦게 도착한 응답 차단).
 * 순수 함수 — 단위 테스트 대상.
 */
export function shouldApplyCommentsResponse(
  requestedDate: string,
  currentDate: string,
  aborted: boolean
): boolean {
  return !aborted && requestedDate === currentDate;
}

export default function BoardComments({ date }: { date: string }) {
  const [comments, setComments] = useState<CommentPublic[]>(() => {
    return (
      peekLastNamespaceResource<CommentsCache>(CLIENT_RESOURCE.BOARD_COMMENTS, date)
        ?.value.comments ?? []
    );
  });
  const [canCompose, setCanCompose] = useState(() => {
    return (
      peekLastNamespaceResource<CommentsCache>(CLIENT_RESOURCE.BOARD_COMMENTS, date)
        ?.value.canCompose ?? false
    );
  });
  const [visible, setVisible] = useState(() => {
    return Boolean(
      peekLastNamespaceResource<CommentsCache>(CLIENT_RESOURCE.BOARD_COMMENTS, date)
    );
  });
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 현재 화면의 날짜. 비동기 응답이 다른 날짜에 섞이지 않도록 비교용. */
  const dateRef = useRef(date);
  dateRef.current = date;
  const refreshAbortRef = useRef<AbortController | null>(null);
  const liveCount = useMemo(
    () => comments.filter((c) => !c.deleted).length,
    [comments]
  );

  const applyList = useCallback((forDate: string, next: CommentsCache) => {
    if (forDate !== dateRef.current) return;
    setComments(next.comments);
    setCanCompose(next.canCompose);
    setVisible(true);
    rememberComments(forDate, next);
  }, []);

  /** 작성·수정·삭제 후 서버 목록으로 즉시 재동기화 (캐시/중복제거 우회). */
  const refreshNow = useCallback(
    async (forDate: string) => {
      refreshAbortRef.current?.abort();
      const ctrl = new AbortController();
      refreshAbortRef.current = ctrl;
      try {
        const res = await fetch(`/api/board/${encodeURIComponent(forDate)}/comments`, {
          credentials: "include",
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (consumeUnauthorizedMemberResponse(res)) return;
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!shouldApplyCommentsResponse(forDate, dateRef.current, ctrl.signal.aborted)) return;
        applyList(forDate, {
          comments: Array.isArray(data.comments) ? (data.comments as CommentPublic[]) : [],
          canCompose: data.canCompose === true,
        });
      } catch {
        // abort / network: keep optimistic state
      }
    },
    [applyList]
  );

  useEffect(() => {
    let cancelled = false;
    refreshAbortRef.current?.abort();
    const cached = peekLastNamespaceResource<CommentsCache>(
      CLIENT_RESOURCE.BOARD_COMMENTS,
      date
    );
    if (cached) {
      setComments(cached.value.comments);
      setCanCompose(cached.value.canCompose);
      setVisible(true);
    } else {
      setVisible(false);
      setComments([]);
      setCanCompose(false);
    }
    setBody("");
    setEditingId(null);
    setEditBody("");
    setError(null);
    (async () => {
      const ns = await ensureClientAuthNamespace();
      if (cancelled) return;
      if (shouldSkipFreshResourceRefresh(cached) && ns) return;
      const res = await runDedupedClientResource(
        ns
          ? clientResourceStoreKey(ns, CLIENT_RESOURCE.BOARD_COMMENTS, date)
          : `anon::board-comments::${date}`,
        () =>
          fetch(`/api/board/${encodeURIComponent(date)}/comments`, {
            credentials: "include",
            cache: "no-store",
          })
      );
      if (cancelled) return;
      if (consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!shouldApplyCommentsResponse(date, dateRef.current, cancelled)) return;
      if (!res.ok) {
        if (!cached) setVisible(false);
        return;
      }
      const next: CommentsCache = {
        comments: Array.isArray(data.comments) ? (data.comments as CommentPublic[]) : [],
        canCompose: data.canCompose === true,
      };
      setComments(next.comments);
      setCanCompose(next.canCompose);
      setVisible(true);
      if (!ns) return;
      writeClientResource(ns, CLIENT_RESOURCE.BOARD_COMMENTS, date, next);
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canCompose) return;
    if (!body.trim()) {
      setError("댓글을 입력해 주세요.");
      return;
    }
    const forDate = date;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/board/${encodeURIComponent(forDate)}/comments`, {
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
    if (forDate !== dateRef.current) return;
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 등록 실패");
      return;
    }
    if (data.comment) {
      setComments((cur) => {
        const next = [...cur, data.comment as CommentPublic];
        rememberComments(forDate, { comments: next, canCompose });
        return next;
      });
      setBody("");
    }
    void refreshNow(forDate);
  }

  function startEdit(item: CommentPublic) {
    setEditingId(item.id);
    setEditBody(item.body ?? "");
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
  }

  async function onSaveEdit(commentId: number) {
    if (busy) return;
    if (!editBody.trim()) {
      setError("댓글을 입력해 주세요.");
      return;
    }
    const forDate = date;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/board/${encodeURIComponent(forDate)}/comments/${commentId}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editBody }),
      }
    );
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (forDate !== dateRef.current) return;
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "댓글 수정 실패");
      return;
    }
    if (data.comment) {
      setComments((cur) => {
        const next = cur.map((c) =>
          c.id === commentId ? (data.comment as CommentPublic) : c
        );
        rememberComments(forDate, { comments: next, canCompose });
        return next;
      });
    }
    cancelEdit();
    void refreshNow(forDate);
  }

  async function onDelete(commentId: number) {
    if (!confirm("이 댓글을 삭제할까요?")) return;
    const forDate = date;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/board/${encodeURIComponent(forDate)}/comments/${commentId}`,
      { method: "DELETE", credentials: "include" }
    );
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (forDate !== dateRef.current) return;
    if (!res.ok) {
      setError("댓글 삭제 실패");
      return;
    }
    setComments((cur) => {
      const next = cur.map((c) =>
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
      );
      rememberComments(forDate, { comments: next, canCompose });
      return next;
    });
    if (editingId === commentId) cancelEdit();
    void refreshNow(forDate);
  }

  if (!visible) return null;

  return (
    <section
      className="course-report-comments board-comments"
      aria-label="댓글"
      data-board-date={date}
    >
      <h2 className="course-report-comments-title">
        댓글 <span className="board-comments-count">{liveCount}</span>
      </h2>
      {error ? (
        <p className="board-comments-error" role="alert">
          {error}
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="board-comments-empty">등록된 댓글이 없습니다.</p>
      ) : (
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
                    {item.edited ? (
                      <span className="board-comment-edited">(수정됨)</span>
                    ) : null}
                    {editingId !== item.id && (item.canEdit || item.canDelete) ? (
                      <span className="board-comment-actions">
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
                            onClick={() => void onDelete(item.id)}
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
                        <button
                          type="button"
                          className="ui-btn course-report-comment-submit"
                          disabled={busy}
                          onClick={cancelEdit}
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary course-report-comment-submit"
                          disabled={busy}
                          onClick={() => void onSaveEdit(item.id)}
                        >
                          {busy ? "저장 중…" : "저장"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="course-report-comment-body">{item.body}</p>
                  )}
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
