/**
 * 당번·마샬·조장 effective 값 (순수 함수).
 * 우선순위: manual override > DailyOpsDuty stored > Spreadsheet read-only fallback.
 * SET과 CLEAR는 다른 상태다. override 행 삭제는 RESTORE(원본)만.
 */

import {
  dutyKindFromOpsRole,
  isDailyOpsDutyRole,
  opsDutyRoleFromKind,
  type DailyOpsDutyRole,
} from "@/lib/dailyOpsDuty";
import type { OpsDutyPanelRow } from "@/lib/opsDutyReadOnlySource";
import {
  DUTY_ROLE_KEY_KIND,
  isOpsDutyRoleKey,
  OPS_DUTY_ROLE_KEYS,
  type DutyExcelEntry,
  type OpsDutyRoleKey,
} from "@/lib/dutyMarshalLeaderParser";

export type OpsDutyOverrideAction = "SET" | "CLEAR";
export type OpsDutyOverrideWriteAction = OpsDutyOverrideAction | "RESTORE";
export type OpsDutyBaseSource = "stored" | "sheet" | "none";

export type OpsDutyOverrideInput = {
  roleKey: string;
  role: DailyOpsDutyRole | string;
  action: OpsDutyOverrideAction;
  caddyId: number | null;
  name?: string | null;
  rawName?: string | null;
  team?: string | null;
};

export type EffectiveOpsDutyRow = OpsDutyPanelRow & {
  overridden: boolean;
  overrideAction?: OpsDutyOverrideAction;
};

export type OpsDutySlotPerson = {
  caddyId: number;
  name: string;
  team: string;
};

export type OpsDutySlotState = {
  roleKey: OpsDutyRoleKey;
  role: DailyOpsDutyRole;
  label: string;
  section: "당번" | "마샬" | "조장";
  person: OpsDutySlotPerson | null;
  overridden: boolean;
  overrideAction: OpsDutyOverrideAction | null;
};

export const OPS_DUTY_SLOT_LABELS: Record<OpsDutyRoleKey, string> = {
  당번_조출_1: "조출1",
  당번_조출_2: "조출2",
  당번_후출_1: "후출1",
  당번_후출_2: "후출2",
  마샬_조출_1: "조출1",
  마샬_조출_2: "조출2",
  마샬_후출_1: "후출1",
  조장_1: "조장",
};

export function opsDutyRoleFromRoleKey(
  roleKey: string
): DailyOpsDutyRole | null {
  const kind = DUTY_ROLE_KEY_KIND[roleKey];
  if (!kind) return null;
  return opsDutyRoleFromKind(kind);
}

export function opsDutySectionFromRole(
  role: DailyOpsDutyRole | string
): "당번" | "마샬" | "조장" | null {
  if (role === "DUTY_AM" || role === "DUTY_PM") return "당번";
  if (role === "MARSHAL_AM" || role === "MARSHAL_PM") return "마샬";
  if (role === "LEADER") return "조장";
  return null;
}

function personFromRow(row: {
  caddyId: number;
  name: string;
  team?: string;
}): OpsDutySlotPerson {
  return {
    caddyId: row.caddyId,
    name: row.name,
    team: String(row.team || "").trim() || "—",
  };
}

export function applyOpsDutyOverrides(
  baseRows: readonly OpsDutyPanelRow[],
  overrides: readonly OpsDutyOverrideInput[]
): EffectiveOpsDutyRow[] {
  const byKey = new Map<string, EffectiveOpsDutyRow>();
  for (const row of baseRows) {
    const roleKey = String(row.roleKey || "").trim();
    if (!isOpsDutyRoleKey(roleKey)) continue;
    byKey.set(roleKey, {
      ...row,
      roleKey,
      overridden: false,
    });
  }

  for (const override of overrides) {
    const roleKey = String(override.roleKey || "").trim();
    if (!isOpsDutyRoleKey(roleKey)) continue;
    const role =
      (isDailyOpsDutyRole(override.role)
        ? override.role
        : opsDutyRoleFromRoleKey(roleKey)) || opsDutyRoleFromRoleKey(roleKey);
    if (!role) continue;
    if (override.action === "CLEAR") {
      byKey.delete(roleKey);
      continue;
    }
    const caddyId = Number(override.caddyId);
    if (!Number.isInteger(caddyId) || caddyId < 1) continue;
    const name = String(override.name || override.rawName || "").trim();
    if (!name) continue;
    byKey.set(roleKey, {
      caddyId,
      name,
      team: String(override.team || "").trim() || "—",
      role,
      roleKey,
      rawName: String(override.rawName || name).trim(),
      overridden: true,
      overrideAction: "SET",
    });
  }

  const out: EffectiveOpsDutyRow[] = [];
  for (const roleKey of OPS_DUTY_ROLE_KEYS) {
    const row = byKey.get(roleKey);
    if (row) out.push(row);
  }
  return out;
}

export function buildOpsDutySlotStates(
  baseRows: readonly OpsDutyPanelRow[],
  overrides: readonly OpsDutyOverrideInput[]
): OpsDutySlotState[] {
  const overrideByKey = new Map(
    overrides
      .filter((row) => isOpsDutyRoleKey(row.roleKey))
      .map((row) => [String(row.roleKey), row])
  );
  const effective = new Map(
    applyOpsDutyOverrides(baseRows, overrides).map((row) => [row.roleKey, row])
  );

  return OPS_DUTY_ROLE_KEYS.map((roleKey) => {
    const role = opsDutyRoleFromRoleKey(roleKey)!;
    const override = overrideByKey.get(roleKey) || null;
    const effectiveRow = effective.get(roleKey) || null;
    return {
      roleKey,
      role,
      label: OPS_DUTY_SLOT_LABELS[roleKey],
      section: opsDutySectionFromRole(role) || "당번",
      person: effectiveRow ? personFromRow(effectiveRow) : null,
      overridden: Boolean(override),
      overrideAction: override?.action || null,
    };
  });
}

export function effectiveDutyEntriesFromRows(
  rows: readonly EffectiveOpsDutyRow[]
): DutyExcelEntry[] {
  const out: DutyExcelEntry[] = [];
  for (const row of rows) {
    if (!isDailyOpsDutyRole(row.role)) continue;
    const rawName = String(row.rawName || row.name || "").trim();
    if (!rawName) continue;
    out.push({
      kind: dutyKindFromOpsRole(row.role),
      roleKey: row.roleKey,
      rawName,
    });
  }
  return out;
}

export function effectiveOpsDutyCaddyIds(
  rows: readonly EffectiveOpsDutyRow[]
): number[] {
  return [...new Set(rows.map((row) => row.caddyId).filter((id) => id > 0))];
}

/** 같은 roleKey는 1명. 같은 role(조출당번 등)에 동일 캐디 중복은 기존 DailyOpsDuty 정책. */
export function sameRoleCaddyConflict(
  rows: readonly EffectiveOpsDutyRow[],
  role: DailyOpsDutyRole,
  roleKey: string,
  caddyId: number
): EffectiveOpsDutyRow | null {
  return (
    rows.find(
      (row) =>
        row.role === role &&
        row.caddyId === caddyId &&
        row.roleKey !== roleKey
    ) || null
  );
}
