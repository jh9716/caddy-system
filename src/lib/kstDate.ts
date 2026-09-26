/**
 * 한국시간(KST, UTC+9) 달력 날짜. 외부 API 없음.
 * 표시 formatting만 여기서 처리. DB 저장값은 UTC 유지.
 */

import { addDays } from "@/lib/krHolidays";

const KST = "Asia/Seoul";

export type KstDisplayStyle = "ymd" | "ymd-hm" | "md-hm" | "captured";

function kstDateParts(now: Date): {
  year: string;
  month: string;
  day: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) throw new Error("KST 날짜 변환 실패");
  return { year, month, day };
}

function kstDateTimeParts(now: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  if (!year || !month || !day) throw new Error("KST 날짜 변환 실패");
  return { year, month, day, hour, minute };
}

function toValidDate(input: Date | string): Date | null {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function kstYmd(now: Date = new Date()): string {
  const { year, month, day } = kstDateParts(now);
  return `${year}-${month}-${day}`;
}

/** 00:30/01:30/02:30 KST cron이 보존하는 대상: 방금 끝난 전날. */
export function previousKstYmd(now: Date = new Date()): string {
  return addDays(kstYmd(now), -1);
}

export function isPastKstYmd(ymd: string, now: Date = new Date()): boolean {
  return ymd < kstYmd(now);
}

/** 공통 KST 표시. 스타일만 다르고 timezone/parsing은 하나. */
export function formatKstDisplay(
  input: Date | string | null | undefined,
  style: KstDisplayStyle
): string {
  if (input == null || input === "") return "";
  const d = toValidDate(input);
  if (!d) return typeof input === "string" ? input : "";
  const p = kstDateTimeParts(d);
  if (style === "ymd") return `${p.year}-${p.month}-${p.day}`;
  if (style === "md-hm") return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  if (style === "captured") {
    return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
  }
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatCapturedAtKst(iso: string): string {
  return formatKstDisplay(iso, "captured") || iso;
}
