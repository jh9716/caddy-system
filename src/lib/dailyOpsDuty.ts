/**
 * 당번·마샬·조장 일일 운영 일정 (순수 함수, DB write 없음)
 * 저장 형태: date + caddyId + role. 파일 binary는 저장하지 않음.
 */

import {
  DUTY_ROLE_LABELS,
  type DutyExcelEntry,
  type DutyRoleKind,
} from "@/lib/dutyMarshalLeaderParser";
import {
  matchCaddyByExactName,
  type NameMatchCaddy,
  type NameMatchResult,
} from "@/lib/dailyCaddyNameMatch";

export const DAILY_OPS_DUTY_ROLES = [
  "DUTY_AM",
  "DUTY_PM",
  "MARSHAL_AM",
  "MARSHAL_PM",
  "LEADER",
] as const;

export type DailyOpsDutyRole = (typeof DAILY_OPS_DUTY_ROLES)[number];

export const OPS_DUTY_ROLE_LABELS: Record<DailyOpsDutyRole, string> = {
  DUTY_AM: "조출당번",
  DUTY_PM: "후출당번",
  MARSHAL_AM: "조출마샬",
  MARSHAL_PM: "후출마샬",
  LEADER: "조장",
};

const KIND_TO_ROLE: Record<DutyRoleKind, DailyOpsDutyRole> = {
  duty_am: "DUTY_AM",
  duty_pm: "DUTY_PM",
  marshal_am: "MARSHAL_AM",
  marshal_pm: "MARSHAL_PM",
  leader: "LEADER",
};

const ROLE_TO_KIND: Record<DailyOpsDutyRole, DutyRoleKind> = {
  DUTY_AM: "duty_am",
  DUTY_PM: "duty_pm",
  MARSHAL_AM: "marshal_am",
  MARSHAL_PM: "marshal_pm",
  LEADER: "leader",
};

export function isDailyOpsDutyRole(value: unknown): value is DailyOpsDutyRole {
  return DAILY_OPS_DUTY_ROLES.includes(String(value) as DailyOpsDutyRole);
}

export function opsDutyRoleFromKind(kind: DutyRoleKind): DailyOpsDutyRole {
  return KIND_TO_ROLE[kind];
}

export function dutyKindFromOpsRole(role: DailyOpsDutyRole): DutyRoleKind {
  return ROLE_TO_KIND[role];
}

export type MatchedOpsDutyRow = {
  role: DailyOpsDutyRole;
  roleKey: string;
  caddyId: number;
  rawName: string;
  name: string;
};

export type OpsDutyReview = {
  role: DailyOpsDutyRole;
  roleKey: string;
  rawName: string;
  reason: string;
};

export type MatchOpsDutyResult = {
  matched: MatchedOpsDutyRow[];
  reviews: OpsDutyReview[];
};

export function matchDutyEntriesToCaddies(
  entries: readonly DutyExcelEntry[],
  caddies: readonly NameMatchCaddy[]
): MatchOpsDutyResult {
  const matched: MatchedOpsDutyRow[] = [];
  const reviews: OpsDutyReview[] = [];
  const usedCaddyRole = new Set<string>();
  const usedRoleKey = new Set<string>();

  for (const entry of entries) {
    const role = opsDutyRoleFromKind(entry.kind);
    const roleKey = String(entry.roleKey || "").trim();
    const rawName = String(entry.rawName || "").trim();
    if (!roleKey || !rawName) continue;
    if (usedRoleKey.has(roleKey)) {
      reviews.push({
        role,
        roleKey,
        rawName,
        reason: "같은 역할 슬롯이 파일에 중복됨",
      });
      continue;
    }
    usedRoleKey.add(roleKey);

    const match: NameMatchResult = matchCaddyByExactName(rawName, caddies);
    if (match.status !== "matched") {
      reviews.push({
        role,
        roleKey,
        rawName: match.name || rawName,
        reason: match.reason,
      });
      continue;
    }
    const dupKey = `${role}:${match.caddyId}`;
    if (usedCaddyRole.has(dupKey)) {
      reviews.push({
        role,
        roleKey,
        rawName,
        reason: "같은 역할에 동일 캐디가 중복됨",
      });
      continue;
    }
    usedCaddyRole.add(dupKey);
    matched.push({
      role,
      roleKey,
      caddyId: match.caddyId,
      rawName,
      name: match.name,
    });
  }

  return { matched, reviews };
}

export function dutyEntriesFromMatched(
  rows: readonly MatchedOpsDutyRow[]
): DutyExcelEntry[] {
  return rows.map((row) => ({
    kind: dutyKindFromOpsRole(row.role),
    roleKey: row.roleKey,
    rawName: row.rawName || row.name,
  }));
}

export function dutyEntriesFromStored(rows: readonly {
  role: DailyOpsDutyRole | string;
  roleKey: string;
  rawName?: string | null;
  name?: string | null;
}): DutyExcelEntry[] {
  const out: DutyExcelEntry[] = [];
  for (const row of rows) {
    if (!isDailyOpsDutyRole(row.role)) continue;
    out.push({
      kind: dutyKindFromOpsRole(row.role),
      roleKey: row.roleKey,
      rawName: String(row.rawName || row.name || "").trim(),
    });
  }
  return out.filter((e) => e.rawName);
}

export function excludeCaddiesById<T extends { id: number }>(
  pool: readonly T[],
  blockedIds: Iterable<number>
): T[] {
  const blocked = new Set(
    [...blockedIds].filter((id) => Number.isInteger(id) && id > 0)
  );
  if (blocked.size === 0) return [...pool];
  return pool.filter((row) => !blocked.has(row.id));
}

export function countByOpsRole(
  rows: readonly { role: DailyOpsDutyRole | string }[]
): Record<DailyOpsDutyRole, number> {
  const counts: Record<DailyOpsDutyRole, number> = {
    DUTY_AM: 0,
    DUTY_PM: 0,
    MARSHAL_AM: 0,
    MARSHAL_PM: 0,
    LEADER: 0,
  };
  for (const row of rows) {
    if (isDailyOpsDutyRole(row.role)) counts[row.role] += 1;
  }
  return counts;
}

export function opsDutyRoleLabel(role: DailyOpsDutyRole): string {
  return OPS_DUTY_ROLE_LABELS[role];
}

export function parseMatchedOpsDutyRows(raw: unknown): MatchedOpsDutyRow[] {
  if (!Array.isArray(raw)) {
    throw new Error("matched[] 필요");
  }
  const matched: MatchedOpsDutyRow[] = [];
  const usedRoleKey = new Set<string>();
  const usedCaddyRole = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error("matched 항목이 올바르지 않습니다.");
    }
    const row = item as Record<string, unknown>;
    const role = row.role;
    const roleKey = String(row.roleKey || "").trim();
    const caddyId = Number(row.caddyId);
    const rawName = String(row.rawName || row.name || "").trim();
    const name = String(row.name || rawName).trim();
    if (!isDailyOpsDutyRole(role)) {
      throw new Error(`알 수 없는 역할입니다: ${String(role)}`);
    }
    if (!roleKey) throw new Error("roleKey가 필요합니다.");
    if (!Number.isInteger(caddyId) || caddyId < 1) {
      throw new Error("caddyId가 올바르지 않습니다.");
    }
    if (!rawName) throw new Error("rawName이 필요합니다.");
    if (usedRoleKey.has(roleKey)) {
      throw new Error(`같은 역할 슬롯이 중복됩니다: ${roleKey}`);
    }
    const dupKey = `${role}:${caddyId}`;
    if (usedCaddyRole.has(dupKey)) {
      throw new Error("같은 역할에 동일 캐디가 중복됩니다.");
    }
    usedRoleKey.add(roleKey);
    usedCaddyRole.add(dupKey);
    matched.push({ role, roleKey, caddyId, rawName, name });
  }
  return matched;
}

export { DUTY_ROLE_LABELS };
