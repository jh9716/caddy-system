/**
 * P4 벌당 발생관리 화면용 순수 UI 계약. 엔진/패커를 바꾸지 않는다.
 */

import { nextYearMonth } from "@/lib/marshalPenaltyOccurrenceDomain";

export const OCCURRENCE_PANEL_TITLE = "벌당 발생관리 (다음 달 전일)";
export const DUTY_PANEL_TITLE = "월표 직접 벌당 (조출/후출)";

export type OccurrenceListItem = {
  id: number;
  caddyId: number;
  occurredOn: string;
  targetYear: number;
  targetMonth: number;
  scheduledOn: string | null;
  pinnedOn?: string | null;
  autoHeldOn?: string | null;
  scheduleSource: "AUTO" | "MANUAL" | string;
  status: string;
  deferReason: string | null;
  reason: string;
  note?: string | null;
  caddy?: { id: number; name: string; team?: string } | null;
};

export type OccurrenceWaitKind =
  | "not_generated"
  | "capacity"
  | "sick"
  | "date_conflict"
  | "needs_regeneration"
  | "inactive"
  | "other"
  | null;

export function occurrenceStatusLabel(status: string): string {
  const raw = String(status || "").toUpperCase();
  if (raw === "SCHEDULED") return "배정됨";
  if (raw === "CANCELLED") return "취소";
  return "대기";
}

export function occurrenceSourceLabel(source: string | null | undefined): string {
  return String(source || "").toUpperCase() === "MANUAL" ? "수동지정" : "자동";
}

export function classifyOccurrenceWait(input: {
  status: string;
  deferReason?: string | null;
  planGenerated?: boolean;
}): { kind: OccurrenceWaitKind; label: string } {
  if (String(input.status || "").toUpperCase() !== "OPEN") {
    return { kind: null, label: "" };
  }
  const reason = String(input.deferReason || "").trim();
  if (reason.includes("재생성이 필요") || reason.includes("월표 생성 이후")) {
    return { kind: "needs_regeneration", label: "재생성 필요" };
  }
  if (reason.includes("장기병가") || reason.includes("병가")) {
    return { kind: "sick", label: "병가" };
  }
  if (
    reason.includes("정원") ||
    reason.includes("배정할 날짜가 없습니다")
  ) {
    return { kind: "capacity", label: "정원 부족" };
  }
  if (
    reason.includes("수동 벌당") ||
    reason.includes("같은 날 이미 벌당") ||
    reason.includes("지정일")
  ) {
    return { kind: "date_conflict", label: "날짜 충돌" };
  }
  if (reason.includes("활성 마샬")) {
    return { kind: "inactive", label: "비활성 마샬" };
  }
  if (!reason) {
    if (input.planGenerated) {
      return { kind: "other", label: "미배정" };
    }
    return { kind: "not_generated", label: "아직 월표 미생성" };
  }
  return { kind: "other", label: reason };
}

export function occurrenceWaitLabel(input: {
  status: string;
  deferReason?: string | null;
  planGenerated?: boolean;
}): string {
  return classifyOccurrenceWait(input).label;
}

export function occurrenceTargetLabel(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

export function targetMonthFromOccurredOnYmd(ymd: string): {
  year: number;
  month: number;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return nextYearMonth(year, month);
}

export function makeOccurrenceIdempotencyKey(input: {
  caddyId: number;
  occurredOn: string;
  nonce: string;
}): string {
  const caddyId = Number(input.caddyId);
  const occurredOn = String(input.occurredOn || "").trim();
  const nonce = String(input.nonce || "").replace(/[^A-Za-z0-9._:-]/g, "");
  return `ui-${caddyId}-${occurredOn}-${nonce}`.slice(0, 128);
}

export function newOccurrenceNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function canChangeOccurrenceDate(input: {
  status: string;
  planStatus?: string | null;
}): boolean {
  const status = String(input.status || "").toUpperCase();
  const planStatus = String(input.planStatus || "").toUpperCase();
  if (status === "CANCELLED") return false;
  if (planStatus === "FINALIZED") return false;
  return status === "OPEN" || status === "SCHEDULED";
}

export function canCancelOccurrence(input: {
  status: string;
  planStatus?: string | null;
}): boolean {
  const status = String(input.status || "").toUpperCase();
  const planStatus = String(input.planStatus || "").toUpperCase();
  if (status === "CANCELLED") return false;
  if (status === "SCHEDULED" && planStatus === "FINALIZED") return false;
  return true;
}

export function occurrenceConflictMessage(input: {
  code?: string | null;
  error?: string | null;
}): string {
  const code = String(input.code || "");
  const error = String(input.error || "").trim();
  if (code === "stale_preview") {
    return "월표가 미리보기 이후 변경되었습니다. 다시 미리보기하세요.";
  }
  if (code === "off_confirm_required") {
    return "휴무일입니다. 미리보기에서 휴무 승인을 체크한 뒤 확정하세요.";
  }
  if (code === "sick_date") {
    return error || "병가/장기병가 날짜는 지정할 수 없습니다.";
  }
  if (code === "date_taken") {
    return error || "같은 날짜에 다른 벌당이 있습니다.";
  }
  if (code === "override_conflict") {
    return error || "대타/수동 슬롯이 있어 그 날에 전일 벌당을 넣을 수 없습니다.";
  }
  if (code === "same_day_duplicate") {
    return error || "같은 날 이미 배정된 마샬입니다.";
  }
  if (code === "preview_token_required") {
    return "미리보기를 먼저 확인한 뒤 변경을 확정하세요.";
  }
  if (code === "finalized_locked") {
    return error || "마감된 월표는 수정할 수 없습니다.";
  }
  if (code === "regeneration_required") {
    return error || "벌당이 변경되어 월표를 다시 생성해야 합니다.";
  }
  return error || "처리에 실패했습니다.";
}

export function regenerationBannerText(input: {
  needsRegeneration?: boolean | null;
  planStatus?: string | null;
}): string | null {
  if (!input.needsRegeneration) return null;
  if (String(input.planStatus || "").toUpperCase() === "FINALIZED") return null;
  return "벌당이 변경되어 월표를 다시 생성해야 합니다. 재생성 전에는 마감할 수 없습니다. 수동 대타는 자동으로 지우지 않습니다.";
}

export function occurrenceCalendarBadgeText(input: {
  name: string;
  source?: string | null;
}): string {
  const name = String(input.name || "").trim() || "이름없음";
  return `${name} 전일·${occurrenceSourceLabel(input.source)}`;
}

export function scheduledOccurrencesOnDate(
  rows: readonly OccurrenceListItem[] | null | undefined,
  ymd: string
): OccurrenceListItem[] {
  return (rows || []).filter(
    (row) =>
      String(row.status).toUpperCase() === "SCHEDULED" &&
      row.scheduledOn === ymd
  );
}

export type OccurrencePreviewView = {
  fromDate: string | null;
  toDate: string;
  requiresOffConfirm?: boolean;
  offWarning?: boolean;
  slotsDeferred?: boolean;
  canApplySlots?: boolean;
  otherOccurrences?: { id: number; unchanged?: boolean }[];
  fromDay?: {
    before: { caddyId: number; name: string | null; source: string }[];
    after: { caddyId: number; name: string | null; source: string }[];
  };
  toDay?: {
    before: { caddyId: number; name: string | null; source: string }[];
    after: { caddyId: number; name: string | null; source: string }[];
  };
  rotationImpact?: {
    displaced?: { caddyId: number; shift: string }[];
    fillers?: {
      caddyId: number;
      shift: string;
      warning: string | null;
    }[];
  };
  previewToken?: string;
};

export function previewOtherDatesUnchanged(
  preview: OccurrencePreviewView | null | undefined
): boolean {
  const rows = preview?.otherOccurrences || [];
  return rows.length === 0 || rows.every((row) => row.unchanged !== false);
}

function uniquePreviewNames(
  slots:
    | { caddyId: number; name: string | null; source: string }[]
    | undefined,
  sources?: readonly string[]
): string[] {
  const wanted = sources?.map((value) => value.toUpperCase());
  const seen = new Set<number>();
  const names: string[] = [];
  for (const slot of slots || []) {
    if (wanted && !wanted.includes(String(slot.source || "").toUpperCase())) {
      continue;
    }
    if (seen.has(slot.caddyId)) continue;
    seen.add(slot.caddyId);
    names.push(slot.name || `#${slot.caddyId}`);
  }
  return names;
}

export function previewExistingPenaltyNames(
  preview: OccurrencePreviewView | null | undefined
): string[] {
  return uniquePreviewNames(preview?.toDay?.before, ["PENALTY"]);
}

export function previewOverrideNames(
  preview: OccurrencePreviewView | null | undefined
): string[] {
  return uniquePreviewNames(preview?.toDay?.before, ["SUBSTITUTE", "MANUAL"]);
}

export function previewChangedNormalNames(
  preview: OccurrencePreviewView | null | undefined,
  names: ReadonlyMap<number, string>
): string[] {
  return namesForCaddyIds(
    (preview?.rotationImpact?.displaced || []).map((row) => row.caddyId),
    names
  );
}

export function namesForCaddyIds(
  ids: readonly number[],
  names: ReadonlyMap<number, string>
): string[] {
  return ids.map((id) => names.get(id) || `#${id}`);
}

export function occurrenceRegisterBlocked(input: {
  locked: boolean;
  caddyId: string;
  occurredOn: string;
  reason: string;
}): boolean {
  if (input.locked) return true;
  return !input.caddyId || !input.occurredOn || !String(input.reason || "").trim();
}
