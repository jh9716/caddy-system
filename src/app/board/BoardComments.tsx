"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentPublic } from "@/lib/comment";
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
import {
  appendCommentUnique,
  commentMutationErrorMessage,
  createMutationGate,
  liveCommentCount,
  markCommentDeleted,
  replaceComment,
} from "@/lib/boardCommentsState";
import CommentThreadPanel from "@/components/comments/CommentThreadPanel";

type CommentsCache = {
  comments: CommentPublic[];
  canCompose: boolean;
};

function rememberComments(date: string, payload: CommentsCache) {
  const ns = readLastClientAuthNamespace();
  if (!ns) return;
  writeClientResource(ns, CLIENT_RESOURCE.BOARD_COMMENTS, date, payload);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateRef = useRef(date);
  dateRef.current = date;
  const refreshAbortRef = useRef<AbortController | null>(null);
  const liveCount = useMemo(() => liveCommentCount(comments), [comments]);
  const gateRef = useRef(createMutationGate());

  const applyList = useCallback((forDate: string, next: CommentsCache) => {
    if (forDate !== dateRef.current) return;
    setComments(next.comments);
    setCanCompose(next.canCompose);
    setVisible(true);
    rememberComments(forDate, next);
  }, []);

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
    gateRef.current.invalidate();
    setBusy(false);
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

  async function runMutation(
    action: "create" | "edit" | "delete",
    forDate: string,
    request: () => Promise<Response>,
    onSuccess: (data: Record<string, unknown>) => void
  ): Promise<boolean> {
    const token = gateRef.current.start();
    setBusy(true);
    setError(null);
    const stillHere = () => gateRef.current.isCurrent(token) && forDate === dateRef.current;
    let res: Response;
    try {
      res = await request();
    } catch {
      if (stillHere()) {
        setBusy(false);
        setError(commentMutationErrorMessage(action, { network: true }));
      }
      return false;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      if (stillHere()) setBusy(false);
      return false;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!stillHere()) return false;
    setBusy(false);
    if (!res.ok) {
      setError(commentMutationErrorMessage(action, { message: data.message }));
      return false;
    }
    onSuccess(data);
    void refreshNow(forDate);
    return true;
  }

  async function onCreate(nextBody: string, parentId: number | null): Promise<boolean> {
    const forDate = date;
    return runMutation(
      "create",
      forDate,
      () =>
        fetch(`/api/board/${encodeURIComponent(forDate)}/comments`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parentId != null ? { body: nextBody, parentId } : { body: nextBody }),
        }),
      (data) => {
        if (data.comment) {
          setComments((cur) => {
            const next = appendCommentUnique(cur, data.comment as CommentPublic);
            rememberComments(forDate, { comments: next, canCompose });
            return next;
          });
        }
      }
    );
  }

  async function onSaveEdit(commentId: number, nextBody: string): Promise<boolean> {
    const forDate = date;
    return runMutation(
      "edit",
      forDate,
      () =>
        fetch(`/api/board/${encodeURIComponent(forDate)}/comments/${commentId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: nextBody }),
        }),
      (data) => {
        if (data.comment) {
          setComments((cur) => {
            const next = replaceComment(cur, data.comment as CommentPublic);
            rememberComments(forDate, { comments: next, canCompose });
            return next;
          });
        }
      }
    );
  }

  async function onDelete(commentId: number): Promise<boolean> {
    const forDate = date;
    return runMutation(
      "delete",
      forDate,
      () =>
        fetch(`/api/board/${encodeURIComponent(forDate)}/comments/${commentId}`, {
          method: "DELETE",
          credentials: "include",
        }),
      () => {
        setComments((cur) => {
          const next = markCommentDeleted(cur, commentId);
          rememberComments(forDate, { comments: next, canCompose });
          return next;
        });
      }
    );
  }

  if (!visible) return null;

  return (
    <CommentThreadPanel
      key={date}
      comments={comments}
      canCompose={canCompose}
      busy={busy}
      error={error}
      liveCount={liveCount}
      dateAttr={date}
      onCreate={onCreate}
      onEdit={onSaveEdit}
      onDelete={onDelete}
    />
  );
}
