/**
 * 한국시간(KST, UTC+9) 달력 날짜. 외부 API 없음.
 */

import { addDays } from "@/lib/krHolidays";

const KST = "Asia/Seoul";

export function kstYmd(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error("KST 날짜 변환 실패");
  return `${y}-${m}-${d}`;
}

/** 00:30/01:30/02:30 KST cron이 보존하는 대상: 방금 끝난 전날. */
export function previousKstYmd(now: Date = new Date()): string {
  return addDays(kstYmd(now), -1);
}

export function isPastKstYmd(ymd: string, now: Date = new Date()): boolean {
  return ymd < kstYmd(now);
}

export function formatCapturedAtKst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}`;
}
