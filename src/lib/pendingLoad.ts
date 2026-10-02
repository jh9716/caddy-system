/**
 * P0 Loading UX helpers. Fetch/cache 정책은 바꾸지 않고
 * stale response와 "빈 숫자 오인"만 가드한다.
 */

import { ymdDaysInYearMonth } from "@/lib/offRequestDomain";

export function isCurrentLoadGen(requestGen: number, latestGen: number): boolean {
  return requestGen === latestGen;
}

export function isStalePublishedBoard(
  publishedDate: string | null | undefined,
  selectedDate: string
): boolean {
  return Boolean(publishedDate && publishedDate !== selectedDate);
}

export function boardPendingCopy(input: {
  loading: boolean;
  selectedDate: string;
  publishedDate: string | null;
  error?: boolean;
}): string | null {
  const stale = isStalePublishedBoard(input.publishedDate, input.selectedDate);
  if (stale && input.loading) {
    return `이전 배치표 표시 중 · ${input.selectedDate} 불러오는 중`;
  }
  if (stale && input.error) {
    return `이전 배치표 표시 중 · ${input.selectedDate} 불러오기 실패`;
  }
  if (input.error && input.publishedDate && !input.loading) {
    return "갱신 실패";
  }
  if (!input.loading) return null;
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

export function isStaleDashboardDate(
  dataDate: string | null | undefined,
  selectedDate: string
): boolean {
  return Boolean(dataDate && dataDate !== selectedDate);
}

export function dashboardUpdatingCopy(input: {
  loading: boolean;
  hasData: boolean;
  staleDate: boolean;
  error: boolean;
  freshness?: "fresh" | "refreshing" | "stale" | "error" | null;
}): string | null {
  if (input.staleDate && input.loading) return "업데이트 중…";
  if (input.staleDate && input.error && !input.loading) {
    return "이전 날짜 표시 중 · 불러오기 실패";
  }
  if (input.freshness === "error") return "최신 정보 확인 실패";
  if (input.freshness === "refreshing" || input.freshness === "stale") {
    return "최신 확인 중…";
  }
  if (input.loading && input.hasData) return "업데이트 중…";
  if (input.error && input.hasData && !input.loading) {
    return "갱신 실패";
  }
  return null;
}
