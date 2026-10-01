import type { OffRequestWindowStatus } from "@/lib/offRequestDomain";

export const OFF_REQUEST_MEMBER_PATH = "/off-requests";
export const OFF_REQUEST_ADMIN_PATH = "/manage/off-requests";

export function offRequestWindowStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "DRAFT":
      return "준비 중";
    case "OPEN":
      return "신청 중";
    case "ADJUSTING":
      return "조정 중";
    case "FINALIZED":
      return "확정";
    default:
      return "신청 기간 없음";
  }
}

export function offRequestWindowHint(status: OffRequestWindowStatus | null | undefined): string {
  if (status == null) return "아직 휴무 신청 전입니다.";
  if (status === "DRAFT") return "아직 휴무 신청 전입니다.";
  if (status === "OPEN") return "원하는 날짜를 눌러 신청하거나, 내 신청일을 다른 날로 옮길 수 있습니다.";
  if (status === "ADJUSTING") return "조정 중입니다.";
  return "이번 달 휴무 신청이 확정되었습니다.";
}

export function shiftYearMonth(yearMonth: string, delta: number): string {
  const [ys, ms] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(ys, ms - 1 + delta, 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function weekdayIndexUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
