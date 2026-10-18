/**
 * /manage/caddies 캐디 클릭 메뉴 — 표시/가드만.
 * PATCH·Preview/Apply 규칙은 바꾸지 않는다.
 */

export type RosterActionMenuPanel = "root" | "move" | "status" | "delete";

export const ROSTER_DIRTY_IMMEDIATE_BLOCK_MESSAGE =
  "저장하지 않은 배치 변경이 있습니다. 먼저 배치를 저장하거나 취소한 뒤 수정·상태 변경·삭제를 하세요.";

/** 드래그 직후 합성 click 만 무시. 이후 의도적 클릭은 통과. */
export const ROSTER_DRAG_CLICK_SUPPRESS_MS = 250;

export function isImmediateRosterMutationBlocked(dirtyCount: number): boolean {
  return Number(dirtyCount) > 0;
}

export function shouldSuppressRosterClick(args: {
  nowMs: number;
  dragEndedAtMs: number | null | undefined;
  windowMs?: number;
  clickedCaddyId?: number | null;
  draggedCaddyId?: number | null;
}): boolean {
  const ended = Number(args.dragEndedAtMs);
  if (!Number.isFinite(ended)) return false;
  const windowMs = Number(args.windowMs ?? ROSTER_DRAG_CLICK_SUPPRESS_MS);
  const dt = Number(args.nowMs) - ended;
  if (!(dt >= 0 && dt < windowMs)) return false;
  const clicked = args.clickedCaddyId;
  const dragged = args.draggedCaddyId;
  if (clicked == null || dragged == null) return true;
  return Number(clicked) === Number(dragged);
}
