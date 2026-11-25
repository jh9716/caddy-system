/**
 * 공지 게시기간(계속 게시 / 오늘만 / 기간 지정 / 예약 게시) 계산.
 * Client-safe: no Prisma, no push, no secrets.
 *
 * - 날짜 계산은 항상 KST 기준 (기기 시간대와 무관).
 * - 종료일은 그날 마지막 시각(KST 23:59:59.999)까지 포함.
 *   서버의 기존 노출 규칙(start <= now <= end)은 바꾸지 않는다.
 * - 어떤 방식에도 맞지 않는 기존 값은 "legacy"로 보고 그대로 둔다.
 */

import { addDays } from "@/lib/krHolidays";
import {
  formatKstDateTimeLocal,
  kstYmd,
  parseKstDateTimeLocal,
} from "@/lib/kstDate";

export const NOTICE_PUBLISH_MODES = ["always", "today", "range", "scheduled"] as const;
export type NoticePublishMode = (typeof NOTICE_PUBLISH_MODES)[number];
/** 수정 화면에서 기존 값이 위 4가지에 맞지 않을 때만 쓰는 상태. */
export type NoticePublishFormMode = NoticePublishMode | "legacy";

export const NOTICE_PUBLISH_MODE_LABELS: Record<NoticePublishMode, string> = {
  always: "계속 게시",
  today: "오늘만",
  range: "기간 지정",
  scheduled: "예약 게시",
};

/** 기간 지정 기본 종료일: 시작일 + 7일. */
export const NOTICE_RANGE_DEFAULT_DAYS = 7;
/** 예약 게시 기본 시각: 내일 09:00 KST. */
export const NOTICE_SCHEDULED_DEFAULT_TIME = "09:00";

export type NoticePublishWindowValue = {
  publishStartAt: Date | null;
  publishEndAt: Date | null;
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const END_OF_DAY_MS = 24 * 60 * 60 * 1000 - 1;

export function isNoticeYmd(value: string | null | undefined): boolean {
  return YMD_RE.test(String(value ?? "").trim());
}

export function isNoticeDateTimeLocal(value: string | null | undefined): boolean {
  return LOCAL_RE.test(String(value ?? "").trim());
}

/** KST 달력일 00:00. */
export function kstStartOfDay(ymd: string): Date {
  return parseKstDateTimeLocal(`${ymd}T00:00`);
}

/** KST 달력일의 마지막 시각 23:59:59.999 (종료일 포함 처리). */
export function kstEndOfDay(ymd: string): Date {
  return new Date(kstStartOfDay(ymd).getTime() + END_OF_DAY_MS);
}

export function isKstStartOfDay(value: Date | null | undefined): boolean {
  if (!value) return false;
  return kstStartOfDay(kstYmd(value)).getTime() === value.getTime();
}

export function isKstEndOfDay(value: Date | null | undefined): boolean {
  if (!value) return false;
  return kstEndOfDay(kstYmd(value)).getTime() === value.getTime();
}

export function toNoticeDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function noticeTodayWindow(now: Date = new Date()): NoticePublishWindowValue {
  const today = kstYmd(now);
  return { publishStartAt: kstStartOfDay(today), publishEndAt: kstEndOfDay(today) };
}

export function noticeRangeDefaultEndYmd(startYmd: string): string {
  return addDays(startYmd, NOTICE_RANGE_DEFAULT_DAYS);
}

export function noticeScheduledDefaultLocal(now: Date = new Date()): string {
  return `${addDays(kstYmd(now), 1)}T${NOTICE_SCHEDULED_DEFAULT_TIME}`;
}

export type NoticePublishFormInput = {
  mode: NoticePublishFormMode;
  /** 기간 지정 시작일 YYYY-MM-DD */
  rangeStartYmd: string;
  /** 기간 지정 종료일 YYYY-MM-DD (포함) */
  rangeEndYmd: string;
  /** 예약 게시 시작 YYYY-MM-DDTHH:mm (KST) */
  scheduledStartLocal: string;
  /** 예약 게시 종료일 YYYY-MM-DD (선택, 포함) */
  scheduledEndYmd: string;
};

export type NoticePublishFormState = NoticePublishFormInput & {
  legacy: NoticePublishWindowValue | null;
};

/** 화면 초기 상태. 수정 화면은 저장된 값에서 방식을 추정한다. */
export function initialNoticePublishForm(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
  now: Date = new Date()
): NoticePublishFormState {
  const today = kstYmd(now);
  const base: NoticePublishFormState = {
    mode: "always",
    rangeStartYmd: today,
    rangeEndYmd: noticeRangeDefaultEndYmd(today),
    scheduledStartLocal: noticeScheduledDefaultLocal(now),
    scheduledEndYmd: "",
    legacy: null,
  };
  const s = toNoticeDate(start);
  const e = toNoticeDate(end);
  if (!s && !e) return base;

  if (s && e && isKstStartOfDay(s) && isKstEndOfDay(e) && s.getTime() <= e.getTime()) {
    const sYmd = kstYmd(s);
    const eYmd = kstYmd(e);
    if (sYmd === today && eYmd === today) {
      return { ...base, mode: "today" };
    }
    return { ...base, mode: "range", rangeStartYmd: sYmd, rangeEndYmd: eYmd };
  }

  if (
    s &&
    s.getUTCSeconds() === 0 &&
    s.getUTCMilliseconds() === 0 &&
    (!e || (isKstEndOfDay(e) && s.getTime() <= e.getTime()))
  ) {
    return {
      ...base,
      mode: "scheduled",
      scheduledStartLocal: formatKstDateTimeLocal(s),
      scheduledEndYmd: e ? kstYmd(e) : "",
    };
  }

  return { ...base, mode: "legacy", legacy: { publishStartAt: s, publishEndAt: e } };
}

export type NoticePublishComputeResult =
  | { ok: true; window: NoticePublishWindowValue }
  | { ok: false; message: string };

export const NOTICE_PUBLISH_MSG_DATE_REQUIRED = "날짜를 선택해 주세요.";
export const NOTICE_PUBLISH_MSG_START_REQUIRED = "예약 게시 시작 시각을 선택해 주세요.";
export const NOTICE_PUBLISH_MSG_END_BEFORE_START =
  "종료일은 시작일보다 빠를 수 없습니다.";

/** 선택한 방식 → 저장할 시작·종료 시각. */
export function computeNoticePublishWindow(
  input: NoticePublishFormInput & { legacy?: NoticePublishWindowValue | null },
  now: Date = new Date()
): NoticePublishComputeResult {
  if (input.mode === "always") {
    return { ok: true, window: { publishStartAt: null, publishEndAt: null } };
  }
  if (input.mode === "today") {
    return { ok: true, window: noticeTodayWindow(now) };
  }
  if (input.mode === "legacy") {
    const legacy = input.legacy ?? { publishStartAt: null, publishEndAt: null };
    return { ok: true, window: legacy };
  }
  if (input.mode === "range") {
    if (!isNoticeYmd(input.rangeStartYmd) || !isNoticeYmd(input.rangeEndYmd)) {
      return { ok: false, message: NOTICE_PUBLISH_MSG_DATE_REQUIRED };
    }
    if (input.rangeEndYmd < input.rangeStartYmd) {
      return { ok: false, message: NOTICE_PUBLISH_MSG_END_BEFORE_START };
    }
    return {
      ok: true,
      window: {
        publishStartAt: kstStartOfDay(input.rangeStartYmd),
        publishEndAt: kstEndOfDay(input.rangeEndYmd),
      },
    };
  }
  // scheduled
  if (!isNoticeDateTimeLocal(input.scheduledStartLocal)) {
    return { ok: false, message: NOTICE_PUBLISH_MSG_START_REQUIRED };
  }
  const start = parseKstDateTimeLocal(input.scheduledStartLocal.trim());
  let end: Date | null = null;
  const endYmd = String(input.scheduledEndYmd ?? "").trim();
  if (endYmd) {
    if (!isNoticeYmd(endYmd)) {
      return { ok: false, message: NOTICE_PUBLISH_MSG_DATE_REQUIRED };
    }
    end = kstEndOfDay(endYmd);
    if (end.getTime() < start.getTime()) {
      return { ok: false, message: NOTICE_PUBLISH_MSG_END_BEFORE_START };
    }
  }
  return { ok: true, window: { publishStartAt: start, publishEndAt: end } };
}

function monthDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

function monthDayTime(d: Date): string {
  const local = formatKstDateTimeLocal(d);
  return `${monthDay(local.slice(0, 10))} ${local.slice(11, 16)}`;
}

/** 입력칸 아래 요약 한 줄. */
export function noticePublishSummary(
  window: NoticePublishWindowValue,
  mode: NoticePublishFormMode
): string {
  const s = window.publishStartAt;
  const e = window.publishEndAt;
  if (!s && !e) return "기한 없이 계속 보입니다.";
  if (mode === "today" && s) return `오늘(${monthDay(kstYmd(s))}) 하루만 보입니다.`;
  if (mode === "range" && s && e) {
    return `${monthDay(kstYmd(s))} ~ ${monthDay(kstYmd(e))} (종료일 하루 끝까지) 보입니다.`;
  }
  if (mode === "scheduled" && s) {
    return e
      ? `${monthDayTime(s)}부터 ${monthDay(kstYmd(e))} 하루 끝까지 보입니다.`
      : `${monthDayTime(s)}부터 계속 보입니다.`;
  }
  const from = s ? monthDayTime(s) : "처음";
  const to = e ? monthDayTime(e) : "기한 없음";
  return `기존 설정 그대로 유지: ${from} ~ ${to}`;
}
