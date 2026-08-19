/**
 * CONFIRMED 배치표 → Schedule / ShiftDuty / ExtraTag 반영용 순수 로직
 * (DB I/O 없음)
 */

import { createHash } from "crypto";
import type { AssignmentKind, AutoAssignmentRow } from "@/lib/autoAssignEngine";
import type { ShiftPart as UiShiftPart } from "@/lib/reservationParser";

export type ConfirmDraftStatus = "DRAFT" | "EDITED" | "CONFIRMED" | "APPLIED";

export type DbShiftPart = "ONE" | "TWO" | "THREE";
export type DbShiftVariant = "NORMAL" | "ONE_THREE" | "ONE_TWO" | "FIFTY_FOUR";

export type ConfirmRequestBody = {
  status: string;
  date: string;
  assignments: AutoAssignmentRow[];
  /** 같은 날짜 기존 배치를 덮어쓸 때 관리자 명시 승인 */
  replace?: boolean;
  /** 클라이언트 제공 멱등 키 (없으면 payloadHash 사용) */
  idempotencyKey?: string;
};

export type ConfirmIssue = {
  code: string;
  message: string;
  caddyId?: number;
};

export type PersistShiftDutyRow = {
  date: Date;
  part: DbShiftPart;
  variant: DbShiftVariant;
  orderNo: number;
  caddyId: number;
  team: string | null;
};

export type PersistScheduleRow = {
  date: Date;
  caddyId: number;
  memo: string | null;
};

export type PersistExtraTagRow = {
  date: Date;
  caddyId: number;
  tag: string;
  createdBy: string;
};

export type ConfirmPersistPlan = {
  date: string;
  dateObj: Date;
  payloadHash: string;
  idempotencyKey: string;
  caddyIds: number[];
  schedules: PersistScheduleRow[];
  shiftDuties: PersistShiftDutyRow[];
  extraTags: PersistExtraTagRow[];
};

const KIND_TAG: Partial<Record<AssignmentKind, string>> = {
  fixed: "고정/찾근",
  fiftyFourHole: "54홀",
  oneThree: "1·3부",
  oneTwo: "1·2부",
  oneMak: "1막",
  driving: "드라이빙",
};

const KIND_VARIANT: Record<AssignmentKind, DbShiftVariant> = {
  regular: "NORMAL",
  fixed: "NORMAL",
  fiftyFourHole: "FIFTY_FOUR",
  oneThree: "ONE_THREE",
  oneTwo: "ONE_TWO",
  oneMak: "NORMAL",
  driving: "NORMAL",
};

export function isConfirmableStatus(status: string): status is "CONFIRMED" {
  return status === "CONFIRMED";
}

export function mapUiShiftToDb(shift: string): DbShiftPart | null {
  const s = String(shift || "").trim();
  if (s === "1부" || s === "ONE" || s === "1") return "ONE";
  if (s === "2부" || s === "TWO" || s === "2") return "TWO";
  if (s === "3부" || s === "THREE" || s === "3") return "THREE";
  return null;
}

export function mapKindToVariant(kind: AssignmentKind | undefined): DbShiftVariant {
  if (!kind) return "NORMAL";
  return KIND_VARIANT[kind] ?? "NORMAL";
}

export function kindToExtraTag(kind: AssignmentKind | undefined): string | null {
  if (!kind) return null;
  return KIND_TAG[kind] ?? null;
}

/** 정규화된 assignments로 안정 해시 (키 순서 고정) */
export function hashConfirmPayload(
  date: string,
  assignments: AutoAssignmentRow[]
): string {
  const normalized = [...assignments]
    .map((a) => ({
      date: a.date,
      shift: a.shift,
      kind: a.kind,
      sequenceIndex: a.sequenceIndex,
      pairId: a.pairId ?? null,
      note: a.note ?? null,
      caddyId: a.caddy?.id ?? null,
      reservation: {
        id: a.reservation?.id ?? null,
        date: a.reservation?.date ?? null,
        course: a.reservation?.course ?? null,
        shift: a.reservation?.shift ?? null,
        teeTime: a.reservation?.teeTime ?? null,
        teamName: a.reservation?.teamName ?? null,
        rawRowIndex: a.reservation?.rawRowIndex ?? null,
      },
    }))
    .sort((x, y) => {
      const ka = `${x.shift}|${x.reservation.teeTime}|${x.reservation.course}|${x.caddyId}|${x.sequenceIndex}`;
      const kb = `${y.shift}|${y.reservation.teeTime}|${y.reservation.course}|${y.caddyId}|${y.sequenceIndex}`;
      return ka.localeCompare(kb);
    });

  return createHash("sha256")
    .update(JSON.stringify({ date, assignments: normalized }))
    .digest("hex");
}

export function validateConfirmRequest(
  body: unknown
): { ok: true; value: ConfirmRequestBody } | { ok: false; issues: ConfirmIssue[] } {
  const issues: ConfirmIssue[] = [];
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      issues: [{ code: "INVALID_BODY", message: "JSON body 필요" }],
    };
  }

  const raw = body as Record<string, unknown>;
  const status = String(raw.status || "");
  const date = String(raw.date || "");
  const assignments = raw.assignments;
  const replace = Boolean(raw.replace);
  const idempotencyKey =
    typeof raw.idempotencyKey === "string" && raw.idempotencyKey.trim()
      ? raw.idempotencyKey.trim()
      : undefined;

  if (!isConfirmableStatus(status)) {
    issues.push({
      code: "STATUS_NOT_CONFIRMED",
      message: `DRAFT/EDITED/APPLIED 상태는 저장할 수 없습니다. CONFIRMED만 허용 (받은 값: ${status || "(empty)"})`,
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    issues.push({
      code: "INVALID_DATE",
      message: "date=YYYY-MM-DD 필요",
    });
  }

  if (!Array.isArray(assignments) || assignments.length === 0) {
    issues.push({
      code: "EMPTY_ASSIGNMENTS",
      message: "assignments 배열이 비어 있거나 없습니다",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const rows = assignments as AutoAssignmentRow[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const caddyId = Number(row?.caddy?.id);
    if (!Number.isInteger(caddyId) || caddyId <= 0) {
      issues.push({
        code: "INVALID_CADDY_ID",
        message: `assignments[${i}].caddy.id 가 유효하지 않습니다`,
        caddyId: Number.isFinite(caddyId) ? caddyId : undefined,
      });
      continue;
    }
    if (row.date && row.date !== date) {
      issues.push({
        code: "DATE_MISMATCH",
        message: `assignments[${i}].date(${row.date}) 가 body.date(${date}) 와 다릅니다`,
        caddyId,
      });
    }
    const part = mapUiShiftToDb(String(row.shift || row.reservation?.shift || ""));
    if (!part) {
      issues.push({
        code: "INVALID_SHIFT",
        message: `assignments[${i}].shift 가 유효하지 않습니다`,
        caddyId,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      status: "CONFIRMED",
      date,
      assignments: rows,
      replace,
      idempotencyKey,
    },
  };
}

/**
 * Schedule / ShiftDuty / ExtraTag 생성 계획
 * - ShiftDuty: 부별 teeTime 순 orderNo
 * - Schedule: 날짜별 유니크 caddy
 * - ExtraTag: special kind만
 */
export function buildConfirmPersistPlan(
  req: ConfirmRequestBody
): ConfirmPersistPlan {
  const dateObj = new Date(`${req.date}T00:00:00.000Z`);
  const payloadHash = hashConfirmPayload(req.date, req.assignments);
  const idempotencyKey = req.idempotencyKey || payloadHash;

  const byPart: Record<DbShiftPart, AutoAssignmentRow[]> = {
    ONE: [],
    TWO: [],
    THREE: [],
  };

  for (const row of req.assignments) {
    const part = mapUiShiftToDb(String(row.shift || row.reservation?.shift || ""));
    if (!part) continue;
    byPart[part].push(row);
  }

  const shiftDuties: PersistShiftDutyRow[] = [];
  for (const part of ["ONE", "TWO", "THREE"] as DbShiftPart[]) {
    const list = [...byPart[part]].sort((a, b) => {
      const ta = a.reservation?.teeTime || "";
      const tb = b.reservation?.teeTime || "";
      if (ta !== tb) return ta.localeCompare(tb);
      return (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0);
    });
    list.forEach((row, idx) => {
      shiftDuties.push({
        date: dateObj,
        part,
        variant: mapKindToVariant(row.kind),
        orderNo: idx + 1,
        caddyId: row.caddy.id,
        team: row.caddy.team ?? null,
      });
    });
  }

  const scheduleMap = new Map<number, PersistScheduleRow>();
  const tagMap = new Map<string, PersistExtraTagRow>();

  for (const row of req.assignments) {
    const id = row.caddy.id;
    if (!scheduleMap.has(id)) {
      const tag = kindToExtraTag(row.kind);
      scheduleMap.set(id, {
        date: dateObj,
        caddyId: id,
        memo: tag ? `auto:${tag}` : null,
      });
    } else if (!scheduleMap.get(id)!.memo) {
      const tag = kindToExtraTag(row.kind);
      if (tag) scheduleMap.get(id)!.memo = `auto:${tag}`;
    }

    const tag = kindToExtraTag(row.kind);
    if (tag) {
      const key = `${id}|${tag}`;
      if (!tagMap.has(key)) {
        tagMap.set(key, {
          date: dateObj,
          caddyId: id,
          tag,
          createdBy: "assignments-confirm",
        });
      }
    }
  }

  const caddyIds = [...scheduleMap.keys()].sort((a, b) => a - b);

  return {
    date: req.date,
    dateObj,
    payloadHash,
    idempotencyKey,
    caddyIds,
    schedules: [...scheduleMap.values()],
    shiftDuties,
    extraTags: [...tagMap.values()],
  };
}

/** UI draft → API body */
export function draftToConfirmBody(
  draft: {
    status: string;
    date: string;
    assignments: AutoAssignmentRow[];
    /** 닫힌 코스 예약은 저장 대상에서 제외 (전달해도 무시) */
    closedCourseReservations?: unknown[];
  },
  opts?: { replace?: boolean; idempotencyKey?: string }
): ConfirmRequestBody {
  // 운영 반영: 열린 코스 배치만 — closedCourseReservations 는 포함하지 않음
  return {
    status: draft.status,
    date: draft.date,
    assignments: draft.assignments,
    replace: opts?.replace,
    idempotencyKey: opts?.idempotencyKey,
  };
}

export function shiftPartLabel(part: DbShiftPart): UiShiftPart {
  if (part === "ONE") return "1부";
  if (part === "TWO") return "2부";
  return "3부";
}
