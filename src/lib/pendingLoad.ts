/**
 * P0 Loading UX helpers. Fetch/cache 정책은 바꾸지 않고
 * stale response와 "빈 숫자 오인"만 가드한다.
 */

import { ymdDaysInYearMonth } from "@/lib/offRequestDomain";

export function isCurrentLoadGen(requestGen: number, latestGen: number): boolean {
  return requestGen === latestGen;
}

export function boardPendingCopy(input: {
  loading: boolean;
  selectedDate: string;
  publishedDate: string | null;
}): string | null {
  if (!input.loading) return null;
  if (input.publishedDate && input.publishedDate !== input.selectedDate) {
    return `이전 배치표 표시 중 · ${input.selectedDate} 불러오는 중`;
  }
  return "업데이트 중…";
}

export function shouldKeepPreviousBoard(published: unknown): boolean {
  return published != null;
}

export function isStaleCalendarMonth(
  dataMonth: string | null | undefined,
  selectedMonth: string
): boolean {
  return !dataMonth || dataMonth !== selectedMonth;
}

export function calendarPlaceholderDates(yearMonth: string): string[] {
  return ymdDaysInYearMonth(yearMonth);
}

export function shouldShowDashboardZeroCount(hasData: boolean): boolean {
  return hasData;
}
