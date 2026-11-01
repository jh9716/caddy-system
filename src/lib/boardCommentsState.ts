import type { CommentPublic } from "@/lib/comment";

/**
 * 배치표 댓글 클라이언트 상태 전이 (순수 함수, 단위 테스트 대상).
 * 서버 응답 성공 후에만 호출 → 낙관적 유령 댓글 없음.
 */
export function appendCommentUnique(list: CommentPublic[], c: CommentPublic): CommentPublic[] {
  if (list.some((x) => x.id === c.id)) return list.map((x) => (x.id === c.id ? c : x));
  return [...list, c];
}

export function replaceComment(list: CommentPublic[], c: CommentPublic): CommentPublic[] {
  return list.map((x) => (x.id === c.id ? c : x));
}

export function markCommentDeleted(list: CommentPublic[], id: number): CommentPublic[] {
  return list.map((c) =>
    c.id === id
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
}

export function liveCommentCount(list: CommentPublic[]): number {
  return list.filter((c) => !c.deleted).length;
}

/** 실패 메시지: 서버 message 우선, 없으면 동작별 기본 문구. 네트워크 오류는 별도 문구. */
export function commentMutationErrorMessage(
  action: "create" | "edit" | "delete",
  outcome: { network: true } | { network?: false; message?: unknown }
): string {
  if ("network" in outcome && outcome.network) {
    return "네트워크 오류로 처리하지 못했습니다. 다시 시도해 주세요.";
  }
  const m = (outcome as { message?: unknown }).message;
  if (typeof m === "string" && m.trim()) return m;
  return action === "create" ? "댓글 등록 실패" : action === "edit" ? "댓글 수정 실패" : "댓글 삭제 실패";
}

/**
 * 진행 중 작업 토큰. 날짜 전환 시 bump → 이전 날짜 작업의 완료 콜백은 무시.
 */
export function createMutationGate() {
  let seq = 0;
  return {
    start(): number {
      seq += 1;
      return seq;
    },
    invalidate(): void {
      seq += 1;
    },
    isCurrent(token: number): boolean {
      return token === seq;
    },
  };
}
