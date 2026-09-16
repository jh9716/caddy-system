/**
 * 알림톡 Published freshness / stale guard (V1).
 * UI·GET preview·향후 POST send 가 같은 판정을 재사용한다.
 * provider 호출 없음. DB write 없음.
 *
 * PUBLISHED_ONLY (Published 있음 + Draft 없음):
 * - publish 는 Draft 가 있어야만 가능하다.
 * - Draft DELETE/reset 은 Published 를 지우지 않는다.
 * - /board 공개 배치표는 Published 만 본다.
 * - 비교할 최신 작업본이 없으므로 마지막 확정본을 유효로 본다 → canSend=true.
 *
 * publishedVersion !== currentDraftVersion (양쪽 유효):
 * - source < draft : 게시 후 작업본 수정 (9/7 v5 vs v39)
 * - source > draft : 작업본 초기화 후 재생성
 * 둘 다 STALE, canSend=false.
 */

export const ALIMTALK_FRESHNESS_STATUSES = [
  "CURRENT",
  "STALE",
  "NO_PUBLISHED",
  "UNKNOWN",
  "PUBLISHED_ONLY",
] as const;

export type AlimtalkPublishedFreshnessStatus =
  (typeof ALIMTALK_FRESHNESS_STATUSES)[number];

export type AlimtalkPublishedFreshness = {
  status: AlimtalkPublishedFreshnessStatus;
  canSend: boolean;
  publishedVersion: number | null;
  currentDraftVersion: number | null;
};

export const ALIMTALK_STALE_TITLE =
  "현재 게시 배치가 최신 작업본과 다릅니다.";
export const ALIMTALK_STALE_PREVIEW_NOTE =
  "이 내용은 최신 작업본이 아닌 게시본 기준입니다.";
export const ALIMTALK_STALE_REPUBLISH_HINT =
  "현재 작업본을 다시 게시한 후 알림톡을 발송할 수 있습니다.";
export const ALIMTALK_BADGE_CURRENT = "최신 배치";
export const ALIMTALK_BADGE_STALE = "게시본 오래됨";
export const ALIMTALK_CANNOT_SEND_LABEL = "발송 불가";
export const ALIMTALK_SENDABLE_STATUS_LABEL = "발송 가능 상태";
export const ALIMTALK_SEND_STATUS_PREFIX = "발송 상태";
export const ALIMTALK_SENDABLE_COUNT_LABEL = "발송 가능";
export const ALIMTALK_CONTACT_READY_LABEL = "연락처 준비";
export const ALIMTALK_GO_ASSIGNMENTS_LABEL = "배치표로 이동";
export const ALIMTALK_ASSIGNMENTS_HREF = "/manage/assignments";
export const ALIMTALK_NOT_SENDABLE = "ALIMTALK_NOT_SENDABLE";
export const ALIMTALK_NOT_SENDABLE_MESSAGE =
  "게시 배치가 최신 작업본과 다르거나 발송할 수 없는 상태입니다.";

export class AlimtalkNotSendableError extends Error {
  status = 409;
  code = ALIMTALK_NOT_SENDABLE;
  freshness: AlimtalkPublishedFreshness;
  constructor(freshness: AlimtalkPublishedFreshness) {
    super(ALIMTALK_NOT_SENDABLE_MESSAGE);
    this.name = "AlimtalkNotSendableError";
    this.freshness = freshness;
  }
}

export function alimtalkReadyCountLabel(canSend: boolean): string {
  return canSend ? ALIMTALK_SENDABLE_COUNT_LABEL : ALIMTALK_CONTACT_READY_LABEL;
}

export function alimtalkBlockedCountLabel(
  status: AlimtalkPublishedFreshnessStatus
): string | null {
  if (status === "CURRENT" || status === "PUBLISHED_ONLY") return null;
  if (status === "STALE") {
    return `${ALIMTALK_SEND_STATUS_PREFIX}: ${ALIMTALK_BADGE_STALE} · ${ALIMTALK_CANNOT_SEND_LABEL}`;
  }
  return `${ALIMTALK_SEND_STATUS_PREFIX}: ${ALIMTALK_CANNOT_SEND_LABEL}`;
}

export function alimtalkStalePublishedVersionLine(
  publishedVersion: number | null | undefined
): string {
  return `게시 버전 v${publishedVersion ?? "—"}`;
}

export function alimtalkStaleDraftVersionLine(
  currentDraftVersion: number | null | undefined
): string {
  return `현재 작업본 v${currentDraftVersion ?? "—"}`;
}

export function alimtalkCurrentPublishedVersionLine(
  publishedVersion: number | null | undefined
): string {
  return `게시 v${publishedVersion ?? "—"}`;
}

export function alimtalkCurrentDraftVersionLine(
  currentDraftVersion: number | null | undefined
): string {
  return `현재 v${currentDraftVersion ?? "—"}`;
}

export function isPositiveDraftVersion(
  value: unknown
): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function resolvePublishedFreshness(input: {
  publishedSourceDraftVersion?: number | null;
  currentDraftVersion?: number | null;
  hasPublished?: boolean;
}): AlimtalkPublishedFreshness {
  const publishedVersion = isPositiveDraftVersion(
    input.publishedSourceDraftVersion
  )
    ? input.publishedSourceDraftVersion
    : null;
  const currentDraftVersion = isPositiveDraftVersion(input.currentDraftVersion)
    ? input.currentDraftVersion
    : null;
  const hasPublished = input.hasPublished === true;

  if (!hasPublished) {
    return {
      status: "NO_PUBLISHED",
      canSend: false,
      publishedVersion: null,
      currentDraftVersion,
    };
  }

  if (publishedVersion == null) {
    return {
      status: "UNKNOWN",
      canSend: false,
      publishedVersion: null,
      currentDraftVersion,
    };
  }

  if (input.currentDraftVersion == null) {
    return {
      status: "PUBLISHED_ONLY",
      canSend: true,
      publishedVersion,
      currentDraftVersion: null,
    };
  }

  if (currentDraftVersion == null) {
    return {
      status: "UNKNOWN",
      canSend: false,
      publishedVersion,
      currentDraftVersion: null,
    };
  }

  if (publishedVersion === currentDraftVersion) {
    return {
      status: "CURRENT",
      canSend: true,
      publishedVersion,
      currentDraftVersion,
    };
  }

  return {
    status: "STALE",
    canSend: false,
    publishedVersion,
    currentDraftVersion,
  };
}

/**
 * 향후 POST send 가 provider 호출 직전에 반드시 호출.
 * UI canSend 를 믿지 말고, 그 시점에 Published+Draft 를 다시 읽은 뒤
 * resolvePublishedFreshness 결과를 넘긴다 (TOCTOU).
 */
export function assertAlimtalkCanSend(
  freshness: AlimtalkPublishedFreshness
): void {
  if (!freshness?.canSend) {
    throw new AlimtalkNotSendableError(freshness);
  }
}
