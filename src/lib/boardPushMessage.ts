import { isYmd } from "@/lib/dailyBoardDraft";
import {
  BOARD_PUSH_BODY_SUFFIX,
  BOARD_PUSH_TITLE,
} from "@/lib/boardPushConstants";

/** `9월 18일` — local copy so alimtalk modules stay untouched. */
export function formatBoardPushDateKo(ymd: string): string {
  const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd ?? "").trim();
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

export function boardPushUrl(ymd: string): string {
  return `/board?date=${ymd}`;
}

export function formatBoardPushBody(ymd: string): string {
  return `${formatBoardPushDateKo(ymd)} ${BOARD_PUSH_BODY_SUFFIX}`;
}

export function buildBoardPushPayload(ymd: string): {
  title: string;
  body: string;
  url: string;
  tag: string;
} {
  if (!isYmd(ymd)) {
    throw new Error("date는 YYYY-MM-DD 이어야 합니다.");
  }
  return {
    title: BOARD_PUSH_TITLE,
    body: formatBoardPushBody(ymd),
    url: boardPushUrl(ymd),
    tag: `board-published-${ymd}`,
  };
}
