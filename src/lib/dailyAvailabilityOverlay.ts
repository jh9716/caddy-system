/**
 * 휴무 Sheet + 당번/마샬/조장 Excel 제외를 가용 결과에 적용.
 * computeAvailability / autoAssign 규칙은 변경하지 않음.
 */

import {
  compareAvailabilityRows,
  type AvailabilityResult,
  type AvailabilityRow,
} from "@/lib/availabilityEngine";
import {
  matchCaddyByExactName,
  type NameMatchCaddy,
} from "@/lib/dailyCaddyNameMatch";
import {
  DUTY_ROLE_LABELS,
  type DutyExcelEntry,
  type DutyRoleKind,
} from "@/lib/dutyMarshalLeaderParser";

export type DailyReviewItem = {
  name: string;
  reason: string;
  source: "off_sheet" | "duty_excel";
};

export type DailyAvailabilitySummary = {
  baseAvailable: number;
  off: number;
  dutyAm: number;
  dutyPm: number;
  marshalAm: number;
  marshalPm: number;
  leader: number;
  duplicateExcluded: number;
  reviewCount: number;
  finalAvailable: number;
  reviews: DailyReviewItem[];
};

export type DailyAvailabilityResult = AvailabilityResult & {
  dailySummary: DailyAvailabilitySummary;
};

const KIND_COUNT_KEY: Record<DutyRoleKind, keyof DailyAvailabilitySummary> = {
  duty_am: "dutyAm",
  duty_pm: "dutyPm",
  marshal_am: "marshalAm",
  marshal_pm: "marshalPm",
  leader: "leader",
};

function emptySummary(baseAvailable: number): DailyAvailabilitySummary {
  return {
    baseAvailable,
    off: 0,
    dutyAm: 0,
    dutyPm: 0,
    marshalAm: 0,
    marshalPm: 0,
    leader: 0,
    duplicateExcluded: 0,
    reviewCount: 0,
    finalAvailable: baseAvailable,
    reviews: [],
  };
}

function rebuildBuckets(rows: AvailabilityRow[]): AvailabilityResult["available"] {
  const available = rows.filter((r) => r.bucket === "available");
  available.sort(compareAvailabilityRows);
  const byType = { HOUSE: [], THIRD: [], DRIVING: [] } as AvailabilityResult["available"]["byType"];
  for (const row of available) byType[row.caddyType].push(row);
  const teamMap = new Map<string, AvailabilityRow[]>();
  for (const row of available) {
    const list = teamMap.get(row.team) ?? [];
    list.push(row);
    teamMap.set(row.team, list);
  }
  const byTeam = [...teamMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ko"))
    .map(([team, teamRows]) => ({ team, rows: teamRows }));
  return { all: available, byType, byTeam };
}

export function applyDailyExternalExclusions(input: {
  availability: AvailabilityResult;
  caddies: readonly NameMatchCaddy[];
  offNames?: string[];
  dutyEntries?: DutyExcelEntry[];
}): DailyAvailabilityResult {
  const base = input.availability;
  const summary = emptySummary(base.counts.available);
  const byId = new Map<number, AvailabilityRow>();
  for (const row of [
    ...base.available.all,
    ...base.special,
    ...base.excluded,
  ]) {
    byId.set(row.id, { ...row, excludedReasons: [...row.excludedReasons] });
  }

  const excludedIds = new Set<number>();
  for (const row of byId.values()) {
    if (row.bucket === "excluded") excludedIds.add(row.id);
  }

  const applyOne = (
    rawName: string,
    source: "off_sheet" | "duty_excel",
    reasonLabel: string,
    onExclude: () => void
  ) => {
    const match = matchCaddyByExactName(rawName, input.caddies);
    if (match.status === "review" || match.status === "inactive") {
      summary.reviews.push({
        name: match.name || rawName,
        reason: match.reason,
        source,
      });
      return;
    }
    const row = byId.get(match.caddyId);
    if (!row) {
      summary.reviews.push({
        name: match.name,
        reason: "일치 캐디를 가용 목록에서 찾지 못함",
        source,
      });
      return;
    }
    if (excludedIds.has(match.caddyId) || row.bucket === "excluded") {
      summary.duplicateExcluded += 1;
      return;
    }
    excludedIds.add(match.caddyId);
    row.bucket = "excluded";
    if (!row.excludedReasons.includes(reasonLabel)) {
      row.excludedReasons.push(reasonLabel);
    }
    onExclude();
  };

  for (const name of input.offNames ?? []) {
    applyOne(name, "off_sheet", "휴무", () => {
      summary.off += 1;
    });
  }
  for (const entry of input.dutyEntries ?? []) {
    const label = DUTY_ROLE_LABELS[entry.kind];
    applyOne(entry.rawName, "duty_excel", label, () => {
      const key = KIND_COUNT_KEY[entry.kind];
      (summary[key] as number) += 1;
    });
  }

  const all = [...byId.values()];
  const available = rebuildBuckets(all);
  const special = all
    .filter((r) => r.bucket === "special")
    .sort(compareAvailabilityRows);
  const excluded = all
    .filter((r) => r.bucket === "excluded")
    .sort(compareAvailabilityRows);

  summary.reviewCount = summary.reviews.length;
  summary.finalAvailable = available.all.length;

  return {
    ...base,
    available,
    special,
    excluded,
    counts: {
      available: available.all.length,
      special: special.length,
      excluded: excluded.length,
      byType: {
        HOUSE: available.byType.HOUSE.length,
        THIRD: available.byType.THIRD.length,
        DRIVING: available.byType.DRIVING.length,
      },
    },
    dailySummary: summary,
  };
}
