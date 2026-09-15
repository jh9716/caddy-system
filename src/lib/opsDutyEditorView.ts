/**
 * 운영현황 당번·마샬·조장 editor view.
 * client-safe: no xlsx, no Node built-ins, no parser value import.
 */

import {
  DUTY_ROLE_KEY_KIND,
  isOpsDutyRoleKey,
  OPS_DUTY_ROLE_KEYS,
  type OpsDutyRoleKey,
} from "@/lib/opsDutyRoleKeys";

export const OPS_DUTY_EDITOR_ROLE_KEYS = OPS_DUTY_ROLE_KEYS;

export type OpsDutyEditorRole =
  | "DUTY_AM"
  | "DUTY_PM"
  | "MARSHAL_AM"
  | "MARSHAL_PM"
  | "LEADER";

export type OpsDutyEditorSection = "당번" | "마샬" | "조장";
export type OpsDutyEditorOverrideAction = "SET" | "CLEAR";

export type OpsDutyEditorPerson = {
  caddyId: number;
  name: string;
  team: string;
};

export type OpsDutyEditorSlot = {
  roleKey: OpsDutyRoleKey;
  role: OpsDutyEditorRole;
  label: string;
  section: OpsDutyEditorSection;
  person: OpsDutyEditorPerson | null;
  overridden: boolean;
  overrideAction: OpsDutyEditorOverrideAction | null;
};

const KIND_TO_ROLE: Record<string, OpsDutyEditorRole> = {
  duty_am: "DUTY_AM",
  duty_pm: "DUTY_PM",
  marshal_am: "MARSHAL_AM",
  marshal_pm: "MARSHAL_PM",
  leader: "LEADER",
};

export const OPS_DUTY_EDITOR_LABELS: Record<OpsDutyRoleKey, string> = {
  당번_조출_1: "조출1",
  당번_조출_2: "조출2",
  당번_후출_1: "후출1",
  당번_후출_2: "후출2",
  마샬_조출_1: "조출1",
  마샬_조출_2: "조출2",
  마샬_후출_1: "후출1",
  조장_1: "조장",
};

function roleFromRoleKey(roleKey: string): OpsDutyEditorRole | null {
  const kind = DUTY_ROLE_KEY_KIND[roleKey];
  if (!kind) return null;
  return KIND_TO_ROLE[kind] || null;
}

function sectionFromRole(role: OpsDutyEditorRole): OpsDutyEditorSection {
  if (role === "DUTY_AM" || role === "DUTY_PM") return "당번";
  if (role === "MARSHAL_AM" || role === "MARSHAL_PM") return "마샬";
  return "조장";
}

function parsePerson(raw: unknown): OpsDutyEditorPerson | null | undefined {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const caddyId = Number(row.caddyId);
  const name = String(row.name ?? "").trim();
  if (!Number.isInteger(caddyId) || caddyId < 1 || !name) return undefined;
  return {
    caddyId,
    name,
    team: String(row.team ?? "").trim() || "—",
  };
}

function parseOverrideAction(raw: unknown): OpsDutyEditorOverrideAction | null | undefined {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase();
  if (value === "SET" || value === "CLEAR") return value;
  return undefined;
}

function parseOneSlot(raw: unknown): OpsDutyEditorSlot | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const roleKey = String(row.roleKey || "").trim();
  if (!isOpsDutyRoleKey(roleKey)) return null;
  const role = roleFromRoleKey(roleKey);
  if (!role) return null;
  if (row.role != null && String(row.role) !== role) return null;
  const section = sectionFromRole(role);
  if (row.section != null && String(row.section) !== section) return null;
  if (typeof row.overridden !== "boolean") return null;
  const overrideAction = parseOverrideAction(row.overrideAction);
  if (overrideAction === undefined) return null;
  if (row.overridden && overrideAction == null) return null;
  if (!row.overridden && overrideAction != null) return null;
  const person = parsePerson(row.person);
  if (person === undefined) return null;
  if (overrideAction === "SET" && person == null) return null;
  if (overrideAction === "CLEAR" && person != null) return null;
  const label = String(row.label || "").trim() || OPS_DUTY_EDITOR_LABELS[roleKey];
  if (label !== OPS_DUTY_EDITOR_LABELS[roleKey]) return null;
  return {
    roleKey,
    role,
    label,
    section,
    person,
    overridden: row.overridden,
    overrideAction,
  };
}

/**
 * GET payload.slots 가 8개 슬롯으로 완전할 때만 editor mode.
 * undefined / null / {} / [] / [null] / malformed → null (기존 SlotBlocks fallback).
 */
export function parseOpsDutyEditorSlots(payload: unknown): OpsDutyEditorSlot[] | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const slotsRaw = (payload as { slots?: unknown }).slots;
  if (!Array.isArray(slotsRaw)) return null;
  const parsed: OpsDutyEditorSlot[] = [];
  const seen = new Set<string>();
  for (const item of slotsRaw) {
    if (item == null) return null;
    const slot = parseOneSlot(item);
    if (!slot) return null;
    if (seen.has(slot.roleKey)) return null;
    seen.add(slot.roleKey);
    parsed.push(slot);
  }
  if (parsed.length !== OPS_DUTY_ROLE_KEYS.length) return null;
  for (const roleKey of OPS_DUTY_ROLE_KEYS) {
    if (!seen.has(roleKey)) return null;
  }
  return OPS_DUTY_ROLE_KEYS.map(
    (roleKey) => parsed.find((slot) => slot.roleKey === roleKey)!
  );
}

export function opsDutyEditorSlotsBySection(
  slots: readonly OpsDutyEditorSlot[],
  section: OpsDutyEditorSection
): OpsDutyEditorSlot[] {
  return slots.filter((slot) => slot.section === section);
}
