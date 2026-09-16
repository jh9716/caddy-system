/**
 * 알림톡 근무안내 미리보기 (V1).
 * DailyBoardPublished placements만 사용. Draft fallback / 실제 발송 / provider 없음.
 * 응답에 phoneNormalized / telPhone 을 넣지 않는다.
 */

import { formatShiftLabel } from "@/lib/caddySearch";
import { maskKrMobile } from "@/lib/caddyPhone";
import { courseLabelKo } from "@/lib/reservationMove";
import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";
import {
  resolvePublishedFreshness,
  type AlimtalkPublishedFreshness,
} from "@/lib/alimtalkPublishedFreshness";

const PHONE_CANONICAL = /^010\d{8}$/;

export const ALIMTALK_PREVIEW_EMPTY_MESSAGE =
  "게시된 배치표가 없습니다.\n배치표를 게시한 후 알림톡 미리보기를 확인할 수 있습니다.";

export type AlimtalkCaddyContact = {
  id: number;
  name?: string | null;
  team?: string | null;
  caddyType?: string | null;
  phoneNormalized?: string | null;
};

export type AlimtalkPreviewPlacement = {
  shift: string;
  teeTime: string;
  course: string;
  courseLabel: string;
};

export type AlimtalkPreviewRecipient = {
  caddyId: number;
  name: string;
  team: string;
  caddyType: string;
  hasPhone: boolean;
  maskedPhone: string | null;
  placements: AlimtalkPreviewPlacement[];
  messagePreview: string;
};

export type AlimtalkWorkNoticePreview = {
  date: string;
  published: boolean;
  sourceDraftVersion: number | null;
  freshness: AlimtalkPublishedFreshness;
  counts: {
    recipients: number;
    /** 연락처 준비 인원. 발송 가능 여부는 freshness.canSend. */
    sendable: number;
    contactReady: number;
    missingPhone: number;
  };
  recipients: AlimtalkPreviewRecipient[];
};

export function formatWorkNoticeDateKo(ymd: string): string {
  const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd ?? "").trim();
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

export function formatWorkNoticeMessage(
  ymd: string,
  placementLines: readonly string[]
): string {
  const lines = placementLines.map((line) => String(line ?? "").trim()).filter(Boolean);
  return [
    "[베르힐CC 근무안내]",
    "",
    `${formatWorkNoticeDateKo(ymd)} 근무 일정입니다.`,
    "",
    ...lines,
    "",
    "근무일정을 확인해 주세요.",
  ].join("\n");
}

function shiftSortIndex(shift: string): number {
  const label = formatShiftLabel(shift);
  if (label === "1부") return 1;
  if (label === "2부") return 2;
  if (label === "3부") return 3;
  return 9;
}

function placementDedupeKey(row: {
  shift: string;
  teeTime: string;
  course: string;
}): string {
  return `${row.shift}|${row.teeTime}|${row.course}`;
}

function comparePlacements(
  a: AlimtalkPreviewPlacement,
  b: AlimtalkPreviewPlacement
): number {
  const sa = shiftSortIndex(a.shift);
  const sb = shiftSortIndex(b.shift);
  if (sa !== sb) return sa - sb;
  const ta = String(a.teeTime ?? "");
  const tb = String(b.teeTime ?? "");
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.course).localeCompare(String(b.course));
}

function compareRecipients(
  a: AlimtalkPreviewRecipient,
  b: AlimtalkPreviewRecipient
): number {
  const fa = a.placements[0];
  const fb = b.placements[0];
  if (fa && fb) {
    const byPlace = comparePlacements(fa, fb);
    if (byPlace !== 0) return byPlace;
  } else if (fa && !fb) return -1;
  else if (!fa && fb) return 1;
  return a.caddyId - b.caddyId;
}

function hasCanonicalPhone(phoneNormalized: string | null | undefined): boolean {
  return Boolean(phoneNormalized && PHONE_CANONICAL.test(phoneNormalized));
}

export function emptyAlimtalkWorkNoticePreview(
  date: string,
  freshness?: AlimtalkPublishedFreshness | null
): AlimtalkWorkNoticePreview {
  return {
    date,
    published: false,
    sourceDraftVersion: null,
    freshness:
      freshness ??
      resolvePublishedFreshness({
        hasPublished: false,
        publishedSourceDraftVersion: null,
        currentDraftVersion: null,
      }),
    counts: { recipients: 0, sendable: 0, contactReady: 0, missingPhone: 0 },
    recipients: [],
  };
}

export function buildAlimtalkWorkNoticePreview(input: {
  payload: Pick<DailyBoardPublishedPayloadV1, "date" | "placements">;
  caddies?: readonly AlimtalkCaddyContact[] | null;
  sourceDraftVersion?: number | null;
  currentDraftVersion?: number | null;
  freshness?: AlimtalkPublishedFreshness | null;
}): AlimtalkWorkNoticePreview {
  const date = String(input.payload?.date ?? "").trim();
  const contactById = new Map<number, AlimtalkCaddyContact>();
  for (const row of input.caddies ?? []) {
    if (!Number.isInteger(row?.id) || row.id <= 0) continue;
    contactById.set(row.id, row);
  }

  type Acc = {
    caddyId: number;
    name: string;
    team: string;
    seen: Set<string>;
    placements: AlimtalkPreviewPlacement[];
  };
  const byCaddy = new Map<number, Acc>();

  for (const raw of input.payload?.placements ?? []) {
    const caddyId = raw?.caddyId;
    if (!Number.isInteger(caddyId) || Number(caddyId) <= 0) continue;
    const id = Number(caddyId);
    const shift = formatShiftLabel(raw.shift);
    const teeTime = String(raw.teeTime ?? "").trim();
    const course = String(raw.course ?? "").trim();
    const courseLabel = courseLabelKo(course);
    const key = placementDedupeKey({ shift, teeTime, course });
    let acc = byCaddy.get(id);
    if (!acc) {
      acc = {
        caddyId: id,
        name: String(raw.caddyName ?? "").trim() || "이름없음",
        team: String(raw.caddyTeam ?? "").trim(),
        seen: new Set<string>(),
        placements: [],
      };
      byCaddy.set(id, acc);
    }
    if (acc.seen.has(key)) continue;
    acc.seen.add(key);
    acc.placements.push({ shift, teeTime, course, courseLabel });
  }

  const recipients: AlimtalkPreviewRecipient[] = [];
  for (const acc of byCaddy.values()) {
    acc.placements.sort(comparePlacements);
    const contact = contactById.get(acc.caddyId);
    const phone = contact?.phoneNormalized ?? null;
    const ok = hasCanonicalPhone(phone);
    const name =
      String(contact?.name ?? "").trim() || acc.name || "이름없음";
    const team = String(contact?.team ?? "").trim() || acc.team;
    const caddyType =
      String(contact?.caddyType ?? "").trim() || "HOUSE";
    const placementLines = acc.placements.map((row) =>
      [row.shift, row.teeTime, row.courseLabel].filter(Boolean).join(" ")
    );
    recipients.push({
      caddyId: acc.caddyId,
      name,
      team,
      caddyType,
      hasPhone: ok,
      maskedPhone: ok ? maskKrMobile(phone) : null,
      placements: acc.placements,
      messagePreview: formatWorkNoticeMessage(date, placementLines),
    });
  }

  recipients.sort(compareRecipients);
  const contactReady = recipients.filter((row) => row.hasPhone).length;
  const sourceDraftVersion =
    typeof input.sourceDraftVersion === "number" ? input.sourceDraftVersion : null;
  const freshness =
    input.freshness ??
    resolvePublishedFreshness({
      hasPublished: true,
      publishedSourceDraftVersion: sourceDraftVersion,
      currentDraftVersion: input.currentDraftVersion ?? null,
    });
  return {
    date,
    published: true,
    sourceDraftVersion,
    freshness,
    counts: {
      recipients: recipients.length,
      sendable: contactReady,
      contactReady,
      missingPhone: recipients.length - contactReady,
    },
    recipients,
  };
}
