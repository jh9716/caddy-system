/**
 * 휴무 신청(OffRequest) domain — 순수 함수 (DB I/O 없음)
 *
 * Assignment(OFF)는 확정 운영 상태 source.
 * OffRequest는 신청 workflow + 감사 이력 (row 삭제 금지).
 */

export const OFF_REQUEST_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
] as const;

export type OffRequestStatus = (typeof OFF_REQUEST_STATUSES)[number];

/** 조별 하루 기본 승인 정원 */
export const OFF_APPROVE_QUOTA_PER_TEAM = 5;

/** 활성(중복 신청 금지) 상태 */
export const OFF_REQUEST_ACTIVE_STATUSES: readonly OffRequestStatus[] = [
  "REQUESTED",
  "APPROVED",
] as const;

export type OffRequestTransition =
  | "SUBMIT"
  | "APPROVE"
  | "REJECT"
  | "CANCEL" // 본인: REQUESTED → CANCELLED
  | "REVOKE"; // 조장/관리자: APPROVED → CANCELLED (+ Assignment 해제)

const TRANSITIONS: Record<
  OffRequestStatus,
  Partial<Record<OffRequestTransition, OffRequestStatus>>
> = {
  REQUESTED: {
    APPROVE: "APPROVED",
    REJECT: "REJECTED",
    CANCEL: "CANCELLED",
  },
  APPROVED: {
    REVOKE: "CANCELLED",
  },
  REJECTED: {},
  CANCELLED: {},
};

export function isOffRequestStatus(value: unknown): value is OffRequestStatus {
  return (
    typeof value === "string" &&
    (OFF_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export function isActiveOffRequestStatus(status: OffRequestStatus): boolean {
  return (OFF_REQUEST_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * YYYY-MM-DD → 로컬 자정 Date (availability parseYmd와 동일 계열)
 */
export function normalizeOffDateInput(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  return d;
}

/** Date → YYYY-MM-DD (로컬 캘린더) */
export function formatOffDateYmd(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("invalid date");
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Assignment(OFF)용 하루 end (23:59:59.999 로컬) */
export function offAssignmentDayRange(ymd: string): {
  startDate: Date;
  endDate: Date;
} {
  const startDate = normalizeOffDateInput(ymd);
  const endDate = new Date(startDate);
  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
}

export function canTransitionOffRequest(
  from: OffRequestStatus,
  action: OffRequestTransition
): boolean {
  return TRANSITIONS[from]?.[action] != null;
}

export function nextOffRequestStatus(
  from: OffRequestStatus,
  action: OffRequestTransition
): OffRequestStatus {
  const next = TRANSITIONS[from]?.[action];
  if (!next) {
    throw new Error(`invalid transition: ${from} + ${action}`);
  }
  return next;
}

export type OffQuotaSnapshot = {
  /** 이미 확정된 OFF 수 (Assignment OFF 또는 동등 approvedCount) */
  approvedCount: number;
  /** REQUESTED 건수 */
  requestedCount: number;
  quota: number;
  /** approvedCount >= quota */
  overQuota: boolean;
  /** 승인 1건을 추가하면 초과가 되는지 (승인 전 경고) */
  approveWouldExceedQuota: boolean;
};

/**
 * 조별 하루 정원 스냅샷.
 * approvedCount에는 수동/레거시 Assignment(OFF) 포함을 권장 (호출측에서 집계).
 */
export function computeOffQuotaSnapshot(input: {
  approvedCount: number;
  requestedCount: number;
  quota?: number;
}): OffQuotaSnapshot {
  const quota = input.quota ?? OFF_APPROVE_QUOTA_PER_TEAM;
  const approvedCount = Math.max(0, Math.floor(Number(input.approvedCount) || 0));
  const requestedCount = Math.max(
    0,
    Math.floor(Number(input.requestedCount) || 0)
  );
  const overQuota = approvedCount >= quota;
  return {
    approvedCount,
    requestedCount,
    quota,
    overQuota,
    approveWouldExceedQuota: approvedCount >= quota,
  };
}

/**
 * 초과 승인 허용 여부.
 * - 정원 미만: 항상 허용
 * - 정원 이상: confirmOverQuota === true 일 때만 허용
 */
export function canApproveAgainstQuota(input: {
  approvedCount: number;
  quota?: number;
  confirmOverQuota?: boolean;
}): { ok: boolean; requiresConfirm: boolean; snapshot: OffQuotaSnapshot } {
  const snapshot = computeOffQuotaSnapshot({
    approvedCount: input.approvedCount,
    requestedCount: 0,
    quota: input.quota,
  });
  if (!snapshot.approveWouldExceedQuota) {
    return { ok: true, requiresConfirm: false, snapshot };
  }
  if (input.confirmOverQuota === true) {
    return { ok: true, requiresConfirm: true, snapshot };
  }
  return { ok: false, requiresConfirm: true, snapshot };
}

/**
 * 승인 후 revoke(CANCELLED) 시 감사 필드 정책.
 * - decidedAt / decidedByUserId / decisionNote(승인 당시) 는 유지
 * - assignmentId 는 해제(null)
 * - status → CANCELLED
 * - OffRequest row 자체는 삭제하지 않음
 *
 * 한계: 누가 언제 revoke 했는지는 이 필드만으로는 약함(updatedAt만).
 * PR-A에서는 별도 audit 모델/revokedAt 없이 위 정책으로 승인 이력은 보존.
 */
export type OffRequestAuditFields = {
  status: OffRequestStatus;
  decidedAt: Date | string | null;
  decidedByUserId: number | null;
  decisionNote: string | null;
  assignmentId: number | null;
};

export function applyRevokePreservingApprovalAudit(
  current: OffRequestAuditFields
): OffRequestAuditFields {
  if (current.status !== "APPROVED") {
    throw new Error("revoke only from APPROVED");
  }
  return {
    status: "CANCELLED",
    decidedAt: current.decidedAt,
    decidedByUserId: current.decidedByUserId,
    decisionNote: current.decisionNote,
    assignmentId: null,
  };
}

export function applyApproveDecision(input: {
  /** 환경변수 admin 등 DB User 미연결 시 null 허용 */
  decidedByUserId: number | null;
  decisionNote?: string | null;
  assignmentId: number;
  at?: Date;
}): Pick<
  OffRequestAuditFields,
  "status" | "decidedAt" | "decidedByUserId" | "decisionNote" | "assignmentId"
> {
  return {
    status: "APPROVED",
    decidedAt: input.at ?? new Date(),
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote ?? null,
    assignmentId: input.assignmentId,
  };
}

export function applyRejectDecision(input: {
  decidedByUserId: number | null;
  decisionNote?: string | null;
  at?: Date;
}): Pick<
  OffRequestAuditFields,
  "status" | "decidedAt" | "decidedByUserId" | "decisionNote" | "assignmentId"
> {
  return {
    status: "REJECTED",
    decidedAt: input.at ?? new Date(),
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote ?? null,
    assignmentId: null,
  };
}
