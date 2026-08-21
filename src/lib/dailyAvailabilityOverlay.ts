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
  resolveOffSheetNameTokens,
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

export type DutyDuplicateDetail = {
  name: string;
  role: string;
  overlappedWith: string;
};

export type DailyAvailabilitySummary = {
  baseAvailable: number;
  off: number;
  /** 파일/저장 원본 인원 (중복 제거 전) */
  dutyAm: number;
  dutyPm: number;
  marshalAm: number;
  marshalPm: number;
  leader: number;
  duplicateExcluded: number;
  /** 당번/마샬/조장으로 새로 빠진 인원 (휴무 등과 겹치면 여기 안 넣음) */
  dutyAdditionalExcluded: number;
  duplicates: DutyDuplicateDetail[];
  reviewCount: number;
  finalAvailable: number;
  reviews: DailyReviewItem[];
};

export type DailyAvailabilityResult = AvailabilityResult & {
  dailySummary: DailyAvailabilitySummary;
  opsDutyCaddyIds: number[];
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
    dutyAdditionalExcluded: 0,
    duplicates: [],
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
  const opsDutyCaddyIds: number[] = [];
  const seenDutyIds = new Set<number>();
  for (const row of byId.values()) {
    if (row.bucket === "excluded") excludedIds.add(row.id);
  }

  const applyOne = (
    rawName: string,
    source: "off_sheet" | "duty_excel",
    reasonLabel: string,
    onExclude: () => void,
    onAlreadyExcluded?: (row: AvailabilityRow, name: string) => void
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
      onAlreadyExcluded?.(row, match.name);
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
    const tokens = resolveOffSheetNameTokens(name, input.caddies);
    for (const token of tokens) {
      applyOne(token, "off_sheet", "휴무", () => {
        summary.off += 1;
      });
    }
  }
  for (const entry of input.dutyEntries ?? []) {
    const label = DUTY_ROLE_LABELS[entry.kind];
    const key = KIND_COUNT_KEY[entry.kind];
    (summary[key] as number) += 1;
    applyOne(
      entry.rawName,
      "duty_excel",
      label,
      () => {
        summary.dutyAdditionalExcluded += 1;
      },
      (row, name) => {
        const overlappedWith = row.excludedReasons[0] || "기타";
        summary.duplicates.push({
          name,
          role: label,
          overlappedWith,
        });
      }
    );
    const dutyMatch = matchCaddyByExactName(entry.rawName, input.caddies);
    if (dutyMatch.status === "matched" && !seenDutyIds.has(dutyMatch.caddyId)) {
      seenDutyIds.add(dutyMatch.caddyId);
      opsDutyCaddyIds.push(dutyMatch.caddyId);
    }
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
    opsDutyCaddyIds,
  };
}
