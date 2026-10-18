/**
 * /manage/caddies 캐디 클릭 메뉴 — 표시/가드만.
 * PATCH·Preview/Apply 규칙은 바꾸지 않는다.
 */

export type RosterActionMenuPanel = "root" | "move" | "status" | "delete";

export const ROSTER_DIRTY_IMMEDIATE_BLOCK_MESSAGE =
  "저장하지 않은 배치 변경이 있습니다. 먼저 배치를 저장하거나 취소한 뒤 수정·상태 변경·삭제를 하세요.";

export function isImmediateRosterMutationBlocked(dirtyCount: number): boolean {
  return Number(dirtyCount) > 0;
}

/** HTML5 드래그 직후 click 이 따라오면 메뉴를 열지 않는다. */
export function shouldSuppressRosterClick(dragOccurred: boolean): boolean {
  return dragOccurred === true;
}
