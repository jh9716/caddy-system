/**
 * 관리자 대시보드 V2 Phase 1 뷰 모델.
 * 기존 availability / DailyOpsDuty 결과를 집계만 한다. 계산 엔진을 복제하지 않음.
 */

import {
  compareAvailabilityRows,
  type AvailabilityBucket,
  type AvailabilityRow,
  type CaddyTypeCode,
} from "@/lib/availabilityEngine";
import type { DailyAvailabilityResult } from "@/lib/dailyAvailabilityOverlay";
import {
  DAILY_OPS_DUTY_ROLES,
  OPS_DUTY_ROLE_LABELS,
  type DailyOpsDutyRole,
  isDailyOpsDutyRole,
} from "@/lib/dailyOpsDuty";
import { PRIMARY_TEAMS, normalizeEmploymentStatus } from "@/lib/caddyManage";

export const ADMIN_OPS_DASHBOARD_ROLES = DAILY_OPS_DUTY_ROLES;

export const CADDY_TYPE_DASH_LABEL: Record<CaddyTypeCode, string> = {
  HOUSE: "HOUSE",
  THIRD: "3부반",
  DRIVING: "드라이빙",
};

/** 화면용 역할명 (기존 enum label에 공백). 새 역할이 아님. */
export const OPS_DUTY_DASHBOARD_LABELS: Record<DailyOpsDutyRole, string> = {
  DUTY_AM: "조출 당번",
  DUTY_PM: "후출 당번",
  MARSHAL_AM: "조출 마샬",
  MARSHAL_PM: "후출 마샬",
  LEADER: "조장",
};

const SUMMARY_REASON_ORDER = [
  "휴무",
  "병가",
  "장기병가",
  "결근",
  "당번",
  "마샬",
  "조출당번",
  "후출당번",
  "조출마샬",
  "후출마샬",
  "조장",
  "타구사고",
  "경조사",
  "휴직(LEAVE)",
] as const;

export type AdminOpsDutyGroup = {
  role: DailyOpsDutyRole;
  label: string;
  names: string[];
};

export type AdminOpsReasonCount = {
  reason: string;
  count: number;
};

export type AdminOpsStatusTone =
  | "available"
  | "off"
  | "sick"
  | "duty"
  | "marshal"
  | "leader"
  | "other";

export type AdminOpsCaddyRow = {
  id: number;
  name: string;
  team: string;
  caddyType: CaddyTypeCode;
  caddyTypeLabel: string;
  bucket: AvailabilityBucket;
  status: "available" | "excluded";
  statusLabel: string;
  statusTone: AdminOpsStatusTone;
  reasons: string[];
};

export type AdminOpsTeamGroup = {
  team: string;
  rows: AdminOpsCaddyRow[];
};

export type AdminOpsDashboardPayload = {
  date: string;
  reconstructedFromCurrentRoster: true;
  roster: {
    activeCount: number;
    houseCount: number;
    thirdCount: number;
  };
  availability: {
    finalAvailable: number;
    houseAvailable: number;
    thirdAvailable: number;
    offCount: number;
    reasonCounts: AdminOpsReasonCount[];
  };
  opsDuties: AdminOpsDutyGroup[];
  caddies: AdminOpsCaddyRow[];
};

export type AdminOpsDutyNameInput = {
  role: DailyOpsDutyRole | string;
  name?: string | null;
  rawName?: string | null;
};

function allAvailabilityRows(result: DailyAvailabilityResult): AvailabilityRow[] {
  return [...result.available.all, ...result.special, ...result.excluded];
}

export function isActiveEmployment(status: unknown): boolean {
  return normalizeEmploymentStatus(status) === "ACTIVE";
}

export function countActiveRoster(rows: readonly Pick<AvailabilityRow, "employmentStatus" | "caddyType">[]): {
  activeCount: number;
  houseCount: number;
  thirdCount: number;
} {
  let activeCount = 0;
  let houseCount = 0;
  let thirdCount = 0;
  for (const row of rows) {
    if (!isActiveEmployment(row.employmentStatus)) continue;
    activeCount += 1;
    if (row.caddyType === "HOUSE") houseCount += 1;
    else if (row.caddyType === "THIRD") thirdCount += 1;
  }
  return { activeCount, houseCount, thirdCount };
}

export function countOffFromReasons(rows: readonly Pick<AvailabilityRow, "excludedReasons">[]): number {
  return rows.filter((row) =>
    row.excludedReasons.some((reason) => reason === "휴무" || reason.startsWith("휴무("))
  ).length;
}

export function countExistingReasons(
  rows: readonly Pick<AvailabilityRow, "excludedReasons">[]
): AdminOpsReasonCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const raw of row.excludedReasons) {
      const reason = String(raw ?? "").trim();
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  const ordered: AdminOpsReasonCount[] = [];
  for (const key of SUMMARY_REASON_ORDER) {
    const count = counts.get(key);
    if (count) ordered.push({ reason: key, count });
  }
  const rest = [...counts.entries()]
    .filter(([reason]) => !SUMMARY_REASON_ORDER.includes(reason as (typeof SUMMARY_REASON_ORDER)[number]))
    .sort((a, b) => a[0].localeCompare(b[0], "ko"))
    .map(([reason, count]) => ({ reason, count }));
  return [...ordered, ...rest];
}

export function groupOpsDutyNames(
  rows: readonly AdminOpsDutyNameInput[]
): AdminOpsDutyGroup[] {
  const namesByRole: Record<DailyOpsDutyRole, string[]> = {
    DUTY_AM: [],
    DUTY_PM: [],
    MARSHAL_AM: [],
    MARSHAL_PM: [],
    LEADER: [],
  };
  for (const row of rows) {
    if (!isDailyOpsDutyRole(row.role)) continue;
    const name = String(row.name || row.rawName || "").trim();
    if (!name) continue;
    if (!namesByRole[row.role].includes(name)) namesByRole[row.role].push(name);
  }
  return ADMIN_OPS_DASHBOARD_ROLES.map((role) => ({
    role,
    label: OPS_DUTY_DASHBOARD_LABELS[role],
    names: namesByRole[role],
  }));
}

const TONE_PRIORITY: AdminOpsStatusTone[] = [
  "sick",
  "duty",
  "marshal",
  "leader",
  "off",
  "other",
];

function toneFromOneReason(reason: string): AdminOpsStatusTone | null {
  const r = String(reason ?? "").trim();
  if (!r) return null;
  if (r === "병가" || r.startsWith("병가(") || r === "장기병가" || r.startsWith("장기병가(")) {
    return "sick";
  }
  if (r === "당번" || r.startsWith("당번(") || r === "조출당번" || r === "후출당번") {
    return "duty";
  }
  if (r === "마샬" || r.startsWith("마샬(") || r === "조출마샬" || r === "후출마샬") {
    return "marshal";
  }
  if (r === "조장" || r.startsWith("조장(")) return "leader";
  if (r === "휴무" || r.startsWith("휴무(")) return "off";
  return "other";
}

export function statusToneFromReasons(
  status: "available" | "excluded",
  reasons: readonly string[]
): AdminOpsStatusTone {
  if (status !== "excluded") return "available";
  let best: AdminOpsStatusTone = "other";
  let bestRank = TONE_PRIORITY.length;
  for (const reason of reasons) {
    const tone = toneFromOneReason(reason);
    if (!tone) continue;
    const rank = TONE_PRIORITY.indexOf(tone);
    if (rank >= 0 && rank < bestRank) {
      best = tone;
      bestRank = rank;
    }
  }
  return best;
}

export function toAdminOpsCaddyRow(row: AvailabilityRow): AdminOpsCaddyRow {
  const excluded = row.bucket === "excluded";
  const reasons = excluded ? [...row.excludedReasons] : [];
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    caddyType: row.caddyType,
    caddyTypeLabel: CADDY_TYPE_DASH_LABEL[row.caddyType],
    bucket: row.bucket,
    status: excluded ? "excluded" : "available",
    statusLabel: excluded ? "제외" : "가용",
    statusTone: statusToneFromReasons(excluded ? "excluded" : "available", reasons),
    reasons,
  };
}

export function matchesCaddyNameQuery(name: string, query: string): boolean {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return String(name ?? "").toLowerCase().includes(q);
}

export function filterDashboardCaddies(
  rows: readonly AdminOpsCaddyRow[],
  query: string
): AdminOpsCaddyRow[] {
  return rows.filter((row) => matchesCaddyNameQuery(row.name, query));
}

export function groupCaddiesByPrimaryTeam(
  rows: readonly AdminOpsCaddyRow[]
): AdminOpsTeamGroup[] {
  const byTeam = new Map<string, AdminOpsCaddyRow[]>();
  for (const team of PRIMARY_TEAMS) byTeam.set(team, []);
  const extras: AdminOpsCaddyRow[] = [];
  for (const row of rows) {
    const list = byTeam.get(row.team);
    if (list) list.push(row);
    else extras.push(row);
  }
  const groups: AdminOpsTeamGroup[] = PRIMARY_TEAMS.map((team) => ({
    team,
    rows: byTeam.get(team) ?? [],
  }));
  if (extras.length > 0) {
    const extraTeams = [...new Set(extras.map((r) => r.team))];
    extraTeams.sort((a, b) => a.localeCompare(b, "ko"));
    for (const team of extraTeams) {
      groups.push({
        team,
        rows: extras.filter((r) => r.team === team),
      });
    }
  }
  return groups;
}

export function buildAdminOpsDashboard(input: {
  date: string;
  availability: DailyAvailabilityResult;
  opsDuties?: readonly AdminOpsDutyNameInput[];
}): AdminOpsDashboardPayload {
  const rows = allAvailabilityRows(input.availability);
  const rosterRows = rows.filter(
    (row) => normalizeEmploymentStatus(row.employmentStatus) !== "RETIRED"
  );
  const caddies = rosterRows
    .slice()
    .sort(compareAvailabilityRows)
    .map(toAdminOpsCaddyRow);

  return {
    date: input.date,
    reconstructedFromCurrentRoster: true,
    roster: countActiveRoster(rows),
    availability: {
      finalAvailable: input.availability.dailySummary.finalAvailable,
      houseAvailable: input.availability.counts.byType.HOUSE,
      thirdAvailable: input.availability.counts.byType.THIRD,
      offCount: countOffFromReasons(rows),
      reasonCounts: countExistingReasons(input.availability.excluded),
    },
    opsDuties: groupOpsDutyNames(input.opsDuties ?? []),
    caddies,
  };
}

export { OPS_DUTY_ROLE_LABELS };
