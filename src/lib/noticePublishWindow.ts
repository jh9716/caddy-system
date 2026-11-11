/**
 * Notice publish window helpers. Client-safe: no Prisma, no push, no secrets.
 * Date-only presets store exclusive end as next KST day 00:00 so the selected
 * end date stays visible all day. Server comparison is [start, end).
 */

import { addDays } from "@/lib/krHolidays";
import {
  formatKstDateTimeLocal,
  kstStartOfDay,
  kstYmd,
  parseKstDateTimeLocal,
  tryParseKstDateTimeLocal,
} from "@/lib/kstDate";
import {
  NOTICE_PUBLISH_FILTERS,
  NOTICE_PUBLISH_MODE_LABELS,
  NOTICE_PUBLISH_QUICK_RANGE_LABELS,
  NOTICE_PUBLISH_STATUS_LABELS,
  type NoticePublishFilter,
  type NoticePublishMode,
  type NoticePublishQuickRange,
  type NoticePublishStatus,
} from "@/lib/noticeConstants";
import type { NoticePublishFields } from "@/lib/noticeTarget";

const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseNoticePublishInstant(
  value: string | Date | null | undefined
): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (DATETIME_LOCAL_RE.test(s)) return tryParseKstDateTimeLocal(s);
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function toNoticeDatetimeLocalValue(
  value: string | Date | null | undefined
): string {
  return formatKstDateTimeLocal(parseNoticePublishInstant(value));
}

export function serializeNoticeDatetimeLocal(
  value: string | null | undefined
): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  return parseKstDateTimeLocal(s).toISOString();
}

/** Inclusive calendar day D → exclusive Date at D+1 00:00 KST. */
export function kstExclusiveEndOfDay(inclusiveEndYmd: string): Date {
  return kstStartOfDay(addDays(inclusiveEndYmd, 1));
}

export function noticeDateOnlyWindow(
  startYmd: string,
  inclusiveEndYmd: string
): NoticePublishFields {
  return {
    publishStartAt: kstStartOfDay(startYmd),
    publishEndAt: kstExclusiveEndOfDay(inclusiveEndYmd),
  };
}

export function noticeTodayOnlyWindow(now: Date = new Date()): NoticePublishFields {
  const today = kstYmd(now);
  return noticeDateOnlyWindow(today, today);
}

function kstMonthStartYmd(now: Date): string {
  return `${kstYmd(now).slice(0, 7)}-01`;
}

function kstNextMonthStartYmd(now: Date): string {
  const ymd = kstMonthStartYmd(now);
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-01`;
}

export function noticeQuickRangeWindow(
  key: NoticePublishQuickRange,
  now: Date = new Date()
): NoticePublishFields {
  const today = kstYmd(now);
  if (key === "today") return noticeDateOnlyWindow(today, today);
  if (key === "3d") return noticeDateOnlyWindow(today, addDays(today, 2));
  if (key === "7d") return noticeDateOnlyWindow(today, addDays(today, 6));
  return {
    publishStartAt: kstStartOfDay(kstMonthStartYmd(now)),
    publishEndAt: kstStartOfDay(kstNextMonthStartYmd(now)),
  };
}

export function noticeScheduledDefaultWindow(
  now: Date = new Date()
): NoticePublishFields {
  return {
    publishStartAt: kstStartOfDay(addDays(kstYmd(now), 1)),
    publishEndAt: null,
  };
}

export function sameNoticeInstant(
  a: Date | null | undefined,
  b: Date | null | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
}

export function inferNoticePublishMode(
  notice: NoticePublishFields,
  now: Date = new Date()
): NoticePublishMode {
  const start = notice.publishStartAt;
  const end = notice.publishEndAt;
  if (!start && !end) return "always";
  const today = noticeTodayOnlyWindow(now);
  if (
    sameNoticeInstant(start, today.publishStartAt) &&
    sameNoticeInstant(end, today.publishEndAt)
  ) {
    return "today";
  }
  if (start && start.getTime() > now.getTime()) return "scheduled";
  return "range";
}

export function applyNoticePublishMode(
  mode: NoticePublishMode,
  current: NoticePublishFields,
  now: Date = new Date()
): NoticePublishFields {
  if (mode === "always") {
    return { publishStartAt: null, publishEndAt: null };
  }
  if (mode === "today") return noticeTodayOnlyWindow(now);
  if (mode === "scheduled") {
    if (current.publishStartAt && current.publishStartAt.getTime() > now.getTime()) {
      return current;
    }
    return {
      publishStartAt: noticeScheduledDefaultWindow(now).publishStartAt,
      publishEndAt: current.publishEndAt,
    };
  }
  if (current.publishStartAt || current.publishEndAt) return current;
  return noticeTodayOnlyWindow(now);
}

/**
 * Matches server visibility: start inclusive, end exclusive.
 * null bound = open. Both null = always live.
 */
export function noticePublishStatus(
  notice: NoticePublishFields,
  now: Date = new Date()
): NoticePublishStatus {
  if (notice.publishStartAt && notice.publishStartAt.getTime() > now.getTime()) {
    return "scheduled";
  }
  if (notice.publishEndAt && notice.publishEndAt.getTime() <= now.getTime()) {
    return "ended";
  }
  return "live";
}

export function noticePublishStatusLabel(
  notice: NoticePublishFields,
  now: Date = new Date()
): string {
  return NOTICE_PUBLISH_STATUS_LABELS[noticePublishStatus(notice, now)];
}

export function noticePublishModeLabel(mode: NoticePublishMode): string {
  return NOTICE_PUBLISH_MODE_LABELS[mode];
}

export function noticePublishQuickRangeLabel(key: NoticePublishQuickRange): string {
  return NOTICE_PUBLISH_QUICK_RANGE_LABELS[key];
}

export function parseNoticePublishFilter(raw: unknown): NoticePublishFilter {
  const v = String(raw ?? "all").trim().toLowerCase();
  if ((NOTICE_PUBLISH_FILTERS as readonly string[]).includes(v)) {
    return v as NoticePublishFilter;
  }
  return "all";
}

export function startIsAfterEnd(
  start: Date | null,
  end: Date | null
): boolean {
  return Boolean(start && end && start.getTime() > end.getTime());
}
