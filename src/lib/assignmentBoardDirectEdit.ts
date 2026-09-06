/**
 * 자동배치 V3-A1 직접 수정 화면용 순수 헬퍼.
 * autoAssignEngine 재계산을 호출하지 않는다.
 */

import type { AutoAssignReservation, AutoAssignResultV1 } from "@/lib/autoAssignEngine";
import type { AvailabilityRow } from "@/lib/availabilityEngine";
import type { DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import { OPS_DUTY_ROLE_LABELS } from "@/lib/dailyOpsDuty";
import { reservationKey } from "@/lib/autoAssignEngine";
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

export function buildUnavailablePanelGroups(input: {
  excluded?: AvailabilityRow[] | null;
  opsDuties?: Array<{
    caddyId: number;
    name?: string;
    team?: string;
    role?: DailyOpsDutyRole | string;
  }> | null;
  specialSupportByShift?: Record<ShiftPart, Array<{ id: number }>> | null;
}): UnavailablePanelGroup[] {
  const byId = new Map<number, UnavailablePanelItem>();

  for (const row of input.excluded || []) {
    const reason = (row.excludedReasons || row.assignmentLabels || []).join(" · ") ||
      "비가용";
    const category = classifyReason(reason);
    const support = supportNoteForCaddy(row.id, input.specialSupportByShift);
    byId.set(row.id, {
      caddyId: row.id,
      name: row.name,
      team: row.team,
      category,
      reason: support ? `${reason} → ${support}` : reason,
    });
  }

  for (const duty of input.opsDuties || []) {
    const id = Number(duty.caddyId);
    if (!id) continue;
    const category = classifyOpsRole(duty.role) || "기타";
    const roleLabel =
      duty.role && duty.role in OPS_DUTY_ROLE_LABELS
        ? OPS_DUTY_ROLE_LABELS[duty.role as DailyOpsDutyRole]
        : String(duty.role || category);
    const existing = byId.get(id);
    if (existing) {
      if (existing.category === "기타" && category !== "기타") {
        existing.category = category;
      }
      if (!existing.reason.includes(roleLabel)) {
        existing.reason = `${existing.reason} · ${roleLabel}`;
      }
      continue;
    }
    byId.set(id, {
      caddyId: id,
      name: String(duty.name || "").trim() || `캐디${id}`,
      team: String(duty.team || "").trim() || "—",
      category,
      reason: roleLabel,
    });
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
