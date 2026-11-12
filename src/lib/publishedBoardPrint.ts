/**
 * 일반 배치표(/board) 인쇄 어댑터 (읽기 전용).
 * - /board 가 이미 불러온 Published(확정·게시) 응답만 사용한다. 새 API 호출 없음.
 * - Published payload → 기존 export draft shape (assignmentDraftFromPublishedPayload: teamName 항상 null)
 * - 조회 중이거나, 화면 날짜와 데이터 날짜가 다르면 인쇄 불가.
 */
import { assignmentDraftFromPublishedPayload } from "@/lib/assignmentBoardExport";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";

export type PublishedBoardPrintInput = {
  /** 화면에서 선택한(조회 중인) 날짜 */
  selectedDate: string;
  loading: boolean;
  published: {
    date: string;
    payload: DailyBoardPublishedPayloadV1;
  } | null | undefined;
};

/** 인쇄 버튼을 보여도 되는지. 확정 데이터 없음 / 조회 중 / 날짜 불일치면 false. */
export function canPrintPublishedBoard(input: PublishedBoardPrintInput): boolean {
  const { published, selectedDate } = input;
  if (input.loading) return false;
  if (!published || !published.payload) return false;
  if (!selectedDate) return false;
  if (published.date !== selectedDate) return false;
  if (published.payload.date !== selectedDate) return false;
  return true;
}

/** 인쇄용 draft. 조건을 만족하지 않으면 null (→ 버튼 숨김). */
export function publishedBoardPrintDraft(
  input: PublishedBoardPrintInput
): AssignmentDraft | null {
  if (!canPrintPublishedBoard(input)) return null;
  const draft = assignmentDraftFromPublishedPayload(input.published!.payload);
  return draft.date === input.selectedDate ? draft : null;
}

export const PUBLISHED_BOARD_PRINT_HINT =
  "확정·게시된 배치표만 인쇄합니다. 인쇄 창에서 용지 A4 · 가로 방향 · 배율 기본(100%)을 확인하세요.";

