/**
 * 자동배치 V3-A1 직접 수정 화면용 순수 헬퍼.
 * autoAssignEngine 재계산을 호출하지 않는다.
 */

import type { AutoAssignReservation, AutoAssignResultV1 } from "@/lib/autoAssignEngine";
import type { AvailabilityRow } from "@/lib/availabilityEngine";
import type { DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import { OPS_DUTY_ROLE_LABELS } from "@/lib/dailyOpsDuty";
import { reservationKey } from "@/lib/autoAssignEngine";
import { isOperationalCaddy } from "@/lib/operationalRoster";
import type { ShiftPart } from "@/lib/reservationParser";

export const UNAVAILABLE_PANEL_CATEGORIES = [
  "휴무",
  "병가",
  "결근",
  "당번",
  "마샬",
  "조장",
] as const;

export type UnavailablePanelCategory =
  | (typeof UNAVAILABLE_PANEL_CATEGORIES)[number]
  | "기타";

export type UnavailablePanelItem = {
  caddyId: number;
  name: string;
  team: string;
  category: UnavailablePanelCategory;
  reason: string;
};

export type UnavailablePanelGroup = {
  category: UnavailablePanelCategory;
  items: UnavailablePanelItem[];
};

export function isHouseRequest(reservation: {
  houseRequest?: boolean | null;
}): boolean {
  return reservation.houseRequest === true;
}

export function mergeDraftOnlyReservationFlags(
  after: AutoAssignResultV1,
  source: {
    assignments?: Array<{ reservation: AutoAssignReservation }>;
    unassignedReservations?: Array<{ reservation: AutoAssignReservation }>;
  } | null | undefined
): AutoAssignResultV1 {
  if (!source) return after;
  const flags = new Map<
    string,
    { houseRequest?: boolean; limousineCart?: boolean }
  >();
  const remember = (reservation: AutoAssignReservation) => {
    flags.set(reservationKey(reservation), {
      houseRequest: reservation.houseRequest,
      limousineCart: reservation.limousineCart,
    });
  };
  for (const row of source.assignments || []) remember(row.reservation);
  for (const row of source.unassignedReservations || []) remember(row.reservation);

  const mergeOne = (reservation: AutoAssignReservation): AutoAssignReservation => {
    const prev = flags.get(reservationKey(reservation));
    if (!prev) return reservation;
    return {
      ...reservation,
      houseRequest:
        reservation.houseRequest !== undefined
          ? reservation.houseRequest
          : prev.houseRequest,
      limousineCart:
        reservation.limousineCart !== undefined
          ? reservation.limousineCart
          : prev.limousineCart,
    };
  };

  return {
    ...after,
    assignments: after.assignments.map((row) => ({
      ...row,
      reservation: mergeOne(row.reservation),
    })),
    unassignedReservations: (after.unassignedReservations || []).map((row) => ({
      ...row,
      reservation: mergeOne(row.reservation),
    })),
  };
}

export function unavailablePanelTotal(
  groups: readonly UnavailablePanelGroup[]
): number {
  return groups.reduce((n, group) => n + group.items.length, 0);
}

export function applyHouseRequestFlag(
  previous: AutoAssignResultV1,
  identityKey: string,
  houseRequest: boolean
): AutoAssignResultV1 {
  const key = String(identityKey || "").trim();
  const match = (reservation: AutoAssignReservation) =>
    reservationKey(reservation) === key;
  return {
    ...previous,
    assignments: previous.assignments.map((row) =>
      match(row.reservation)
        ? { ...row, reservation: { ...row.reservation, houseRequest } }
        : row
    ),
    unassignedReservations: (previous.unassignedReservations || []).map((row) =>
      match(row.reservation)
        ? { ...row, reservation: { ...row.reservation, houseRequest } }
        : row
    ),
  };
}

function classifyReason(raw: string): UnavailablePanelCategory {
  const text = String(raw || "").trim();
  if (/결근|미출근|ATTENDANCE/.test(text)) return "결근";
  if (/병가|SICK/.test(text)) return "병가";
  if (/휴무|^OFF\b/.test(text)) return "휴무";
  if (/조장|LEADER/.test(text)) return "조장";
  if (/마샬|MARSHAL/.test(text)) return "마샬";
  if (/당번|DUTY/.test(text)) return "당번";
  return "기타";
}

function classifyOpsRole(role: string | null | undefined): UnavailablePanelCategory | null {
  const r = String(role || "").trim().toUpperCase();
  if (r === "LEADER") return "조장";
  if (r === "MARSHAL_AM" || r === "MARSHAL_PM") return "마샬";
  if (r === "DUTY_AM" || r === "DUTY_PM") return "당번";
  return null;
}

export function supportNoteForCaddy(
  caddyId: number,
  specialSupportByShift?: Record<ShiftPart, Array<{ id: number }>> | null
): string | null {
  if (!specialSupportByShift) return null;
  const shifts: ShiftPart[] = ["1부", "2부", "3부"];
  const hit = shifts.filter((shift) =>
    (specialSupportByShift[shift] || []).some((c) => Number(c.id) === caddyId)
  );
  if (hit.length === 0) return null;
  return `${hit.join("·")} 지원`;
}

export function offCaddiesFromRoster(
  caddyIds: readonly number[] | null | undefined,
  roster: ReadonlyArray<{
    id: number;
    name?: string;
    team?: string;
    employmentStatus?: unknown;
    excludedReasons?: readonly string[] | null;
  }> | null | undefined
): Array<{ id: number; name: string; team: string }> {
  const byId = new Map((roster || []).map((row) => [Number(row.id), row]));
  const out: Array<{ id: number; name: string; team: string }> = [];
  for (const raw of caddyIds || []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) continue;
    const hit = byId.get(id);
    if (!hit || !isOperationalCaddy(hit)) continue;
    out.push({
      id,
      name: String(hit.name || "").trim() || `캐디${id}`,
      team: String(hit.team || "").trim() || "—",
    });
  }
  return out;
}

function upsertUnavailableItem(
  byId: Map<number, UnavailablePanelItem>,
  item: UnavailablePanelItem
) {
  const existing = byId.get(item.caddyId);
  if (!existing) {
    byId.set(item.caddyId, item);
    return;
  }
  if (existing.category === "기타" && item.category !== "기타") {
    existing.category = item.category;
  }
  if (item.reason && !existing.reason.includes(item.reason)) {
    existing.reason = existing.reason
      ? `${existing.reason} · ${item.reason}`
      : item.reason;
  }
  if (existing.name.startsWith("캐디") && item.name && !item.name.startsWith("캐디")) {
    existing.name = item.name;
  }
  if ((existing.team === "—" || !existing.team) && item.team) {
    existing.team = item.team;
  }
}

export function buildUnavailablePanelGroups(input: {
  excluded?: AvailabilityRow[] | null;
  opsDuties?: Array<{
    caddyId: number;
    name?: string;
    team?: string;
    role?: DailyOpsDutyRole | string;
    employmentStatus?: unknown;
  }> | null;
  offCaddies?: Array<{
    id: number;
    name?: string;
    team?: string;
    employmentStatus?: unknown;
  }> | null;
  dailyUnavailables?: Array<{
    caddyId: number;
    name?: string;
    team?: string;
    reason?: string;
    employmentStatus?: unknown;
  }> | null;
  specialSupportByShift?: Record<ShiftPart, Array<{ id: number }>> | null;
}): UnavailablePanelGroup[] {
  const byId = new Map<number, UnavailablePanelItem>();

  for (const row of input.excluded || []) {
    if (!isOperationalCaddy(row)) continue;
    const reason = (row.excludedReasons || row.assignmentLabels || []).join(" · ") ||
      "비가용";
    const rawCategory = classifyReason(reason);
    const category =
      rawCategory === "병가" || rawCategory === "결근" ? "기타" : rawCategory;
    upsertUnavailableItem(byId, {
      caddyId: row.id,
      name: row.name,
      team: row.team,
      category,
      reason,
    });
  }

  for (const row of input.offCaddies || []) {
    const id = Number(row.id);
    if (!id) continue;
    upsertUnavailableItem(byId, {
      caddyId: id,
      name: String(row.name || "").trim() || `캐디${id}`,
      team: String(row.team || "").trim() || "—",
      category: "휴무",
      reason: "휴무",
    });
  }

  for (const row of input.dailyUnavailables || []) {
    const id = Number(row.caddyId);
    if (!id) continue;
    if (!isOperationalCaddy({ ...row, id })) continue;
    const raw = String(row.reason || "").trim();
    if (!raw) continue;
    const category = /ATTENDANCE|결근|미출근/.test(raw)
      ? "결근"
      : /SICK|병가/.test(raw)
        ? "병가"
        : classifyReason(raw);
    if (category !== "병가" && category !== "결근") continue;
    upsertUnavailableItem(byId, {
      caddyId: id,
      name: String(row.name || "").trim() || `캐디${id}`,
      team: String(row.team || "").trim() || "—",
      category,
      reason: category === "결근" ? "결근" : "병가",
    });
  }

  for (const duty of input.opsDuties || []) {
    const id = Number(duty.caddyId);
    if (!id) continue;
    if (!isOperationalCaddy({ ...duty, id })) continue;
    const category = classifyOpsRole(duty.role) || "기타";
    const roleLabel =
      duty.role && duty.role in OPS_DUTY_ROLE_LABELS
        ? OPS_DUTY_ROLE_LABELS[duty.role as DailyOpsDutyRole]
        : String(duty.role || category);
    upsertUnavailableItem(byId, {
      caddyId: id,
      name: String(duty.name || "").trim() || `캐디${id}`,
      team: String(duty.team || "").trim() || "—",
      category,
      reason: roleLabel,
    });
  }

  for (const item of byId.values()) {
    const support = supportNoteForCaddy(item.caddyId, input.specialSupportByShift);
    if (support && !item.reason.includes("지원")) {
      item.reason = `${item.reason} → ${support}`;
    }
  }

  const grouped = new Map<UnavailablePanelCategory, UnavailablePanelItem[]>();
  for (const cat of [...UNAVAILABLE_PANEL_CATEGORIES, "기타"] as UnavailablePanelCategory[]) {
    grouped.set(cat, []);
  }
  for (const item of byId.values()) {
    grouped.get(item.category)?.push(item);
  }
  for (const items of grouped.values()) {
    items.sort(
      (a, b) =>
        a.team.localeCompare(b.team, "ko") || a.name.localeCompare(b.name, "ko")
    );
  }
  return ([...UNAVAILABLE_PANEL_CATEGORIES, "기타"] as UnavailablePanelCategory[])
    .map((category) => ({ category, items: grouped.get(category) || [] }))
    .filter((group) => group.items.length > 0);
}
