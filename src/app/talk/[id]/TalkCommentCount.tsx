"use client";

/**
 * 자유게시판 상세: 상단 "댓글 N" 과 아래 댓글 영역의 숫자를 같은 상태로 묶는다.
 * - 처음 값은 서버가 센 살아있는 댓글 수(countCommunityComments)
 * - 이후 댓글 등록·수정·삭제·재조회 때 FreeBoardComments 가 계산한 liveCount 로 갱신
 * 가배치표(/community)는 이 파일을 쓰지 않는다.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import FreeBoardComments from "@/app/community/[id]/FreeBoardComments";
import type { FreeBoardCommentPublic } from "@/lib/freeBoardComments";

type Ctx = { count: number; setCount: (n: number) => void };
const TalkCommentCountContext = createContext<Ctx | null>(null);

export function TalkCommentCountProvider({ initialCount, children }: { initialCount: number; children: ReactNode }) {
  const [count, setCount] = useState(initialCount);
  return <TalkCommentCountContext.Provider value={{ count, setCount }}>{children}</TalkCommentCountContext.Provider>;
}

export function TalkCommentCountLabel({ fallback }: { fallback: number }) {
  const ctx = useContext(TalkCommentCountContext);
  return <span data-testid="talk-header-comment-count">댓글 {ctx ? ctx.count : fallback}</span>;
}

export function TalkComments(props: {
  postId: number;
  initialComments: FreeBoardCommentPublic[];
  canCompose: boolean;
  apiBase: string;
}) {
  const ctx = useContext(TalkCommentCountContext);
  return <FreeBoardComments {...props} onLiveCountChange={ctx?.setCount} />;
}
