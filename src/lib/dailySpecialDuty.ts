/**
 * 날짜별 관리자 특수근무 입력 (순수 도메인, DB write 없음)
 * - 같은 유형 내부 순서 = 입력/sortOrder (이름순·조순 재정렬 금지)
 * - 유형 간 엔진 우선순위는 autoAssignEngine 기존 규칙 재사용
 */

import {
  matchCaddyByExactName,
  splitPersonNames,
  type NameMatchCaddy,
  type NameMatchResult,
} from "@/lib/dailyCaddyNameMatch";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";

export const DAILY_SPECIAL_KINDS = [
  "ONE_MAK",
  "ONE_TWO",
  "ONE_THREE",
  "FIFTY_FOUR",
  "CHAGEUN",
] as const;

/** 운영 등록 UI. 찾근(CHAGEUN)은 레거시 row 표시/삭제만 허용. */
export const DAILY_SPECIAL_KIND_UI = [
  "ONE_MAK",
  "ONE_TWO",
  "ONE_THREE",
  "FIFTY_FOUR",
] as const;

export type DailySpecialKind = (typeof DAILY_SPECIAL_KINDS)[number];

export const DAILY_SPECIAL_KIND_LABELS: Record<DailySpecialKind, string> = {
  ONE_MAK: "1막",
  ONE_TWO: "1·2부",
  ONE_THREE: "1·3부",
  FIFTY_FOUR: "54홀",
  CHAGEUN: "찾근",
};

export const SPECIAL_DUTY_CHANGED_MESSAGE =
  "특수근무 설정이 변경되었습니다. 현재 작업본에 반영하려면 자동배치를 다시 실행하세요.";

/** 배치표 상단에 바로 노출하는 재배치 안내. 자동 재계산하지 않음. */
export const SPECIAL_SETTINGS_STALE_MESSAGE =
  "특수 설정이 변경되었습니다. 현재 작업본에 반영하려면 배치를 다시 맞춰 주세요.";

/** 엔진 후보 배열에 연결되는 유형 */
export const ENGINE_SPECIAL_KINDS = [
  "ONE_MAK",
  "ONE_TWO",
  "ONE_THREE",
  "FIFTY_FOUR",
  "CHAGEUN",
] as const;

export const ANCHOR_SPECIAL_KINDS = ["ONE_THREE", "ONE_MAK"] as const;

export type AnchorSpecialKind = (typeof ANCHOR_SPECIAL_KINDS)[number];

export function isDailySpecialKind(value: unknown): value is DailySpecialKind {
  return DAILY_SPECIAL_KINDS.includes(String(value) as DailySpecialKind);
}

/** 특수근무 UI는 selected date의 payload만 반영. 다른 날짜 응답은 stale. */
export function isSpecialDutyPayloadForSelectedDate(
  payload: { date?: string | null },
  selectedDate: string
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return false;
  return payload.date === selectedDate;
}

export function isAnchorSpecialKind(value: unknown): value is AnchorSpecialKind {
  return ANCHOR_SPECIAL_KINDS.includes(String(value) as AnchorSpecialKind);
}

export type SpecialStartAnchor = {
  course: string;
  teeTime: string;
};

export type SpecialDutyAnchors = {
  ONE_THREE: SpecialStartAnchor | null;
  ONE_MAK: SpecialStartAnchor | null;
};

export type SpecialDutyConflictCode = "CROSS_KIND" | "UNAVAILABLE" | "INACTIVE";

export type SpecialDutyConflict = {
  code: SpecialDutyConflictCode;
  message: string;
  otherKind?: DailySpecialKind;
};

export type SpecialDutyRecord = {
  id?: number;
  kind: DailySpecialKind;
  caddyId: number;
  sortOrder: number;
  name?: string;
  team?: string;
  teamOrder?: number;
  caddyType?: string | null;
  employmentStatus?: string;
};

export function splitPastedSpecialNames(raw: unknown): string[] {
  const text = String(raw ?? "").replace(/\u00a0/g, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const name of splitPersonNames(line)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function nextSortOrder(existing: readonly number[]): number {
  if (!existing.length) return 1;
  return Math.max(...existing) + 1;
}

export function renumberSortOrders<T>(items: readonly T[]): Array<T & { sortOrder: number }> {
  return items.map((item, index) => ({ ...item, sortOrder: index + 1 }));
}

export function moveItemIndex<T>(
  items: readonly T[],
  index: number,
  direction: -1 | 1
): T[] {
  const nextIndex = index + direction;
  if (
    index < 0 ||
    nextIndex < 0 ||
    index >= items.length ||
    nextIndex >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const tmp = next[index];
  next[index] = next[nextIndex];
  next[nextIndex] = tmp;
  return next;
}

export function hasDuplicateKind(
  existing: readonly Pick<SpecialDutyRecord, "kind" | "caddyId">[],
  kind: DailySpecialKind,
  caddyId: number
): boolean {
  return existing.some((row) => row.kind === kind && row.caddyId === caddyId);
}

export type SpecialDutyPick = {
  caddyId: number;
  name: string;
  team?: string;
  teamOrder?: number;
};

export function appendSpecialDutyPick(
  selected: readonly SpecialDutyPick[],
  pick: SpecialDutyPick
): { selected: SpecialDutyPick[]; duplicate: boolean } {
  if (selected.some((row) => row.caddyId === pick.caddyId)) {
    return { selected: [...selected], duplicate: true };
  }
  return { selected: [...selected, pick], duplicate: false };
}

export function mergePastedSpecialDutyPicks(input: {
  selected: readonly SpecialDutyPick[];
  namesText: string;
  caddies: ReadonlyArray<{
    id: number;
    name: string;
    team?: string;
    teamOrder?: number;
    employmentStatus: string;
  }>;
}): {
  selected: SpecialDutyPick[];
  unmatched: string[];
  duplicates: string[];
} {
  const pasted = resolvePastedSpecialNames(input.namesText, input.caddies);
  let selected = [...input.selected];
  const duplicates: string[] = [];
  for (const hit of pasted.matched) {
    const roster = input.caddies.find((c) => c.id === hit.caddyId);
    const next = appendSpecialDutyPick(selected, {
      caddyId: hit.caddyId,
      name: hit.name,
      team: roster?.team,
      teamOrder: roster?.teamOrder,
    });
    if (next.duplicate) duplicates.push(hit.name);
    selected = next.selected;
  }
  return {
    selected,
    unmatched: pasted.reviews.map((row) => row.name),
    duplicates,
  };
}

/** 한 명씩 POST vs 마지막 1회 batch. */
export function specialDutyRegisterRequestCount(selectedCount: number): {
  perPerson: number;
  batch: number;
} {
  return {
    perPerson: Math.max(0, selectedCount),
    batch: selectedCount > 0 ? 1 : 0,
  };
}

export function detectCrossKindConflicts(
  existing: readonly Pick<SpecialDutyRecord, "kind" | "caddyId">[],
  kind: DailySpecialKind,
  caddyId: number
): SpecialDutyConflict[] {
  return existing
    .filter((row) => row.caddyId === caddyId && row.kind !== kind)
    .map((row) => ({
      code: "CROSS_KIND" as const,
      otherKind: row.kind,
      message: `같은 날짜에 ${DAILY_SPECIAL_KIND_LABELS[row.kind]}에도 등록됨 — 임의 처리하지 않음`,
    }));
}

export function detectUnavailableConflicts(
  caddyId: number,
  unavailableById: ReadonlyMap<number, string[]>
): SpecialDutyConflict[] {
  const reasons = unavailableById.get(caddyId);
  if (!reasons?.length) return [];
  const inactive = reasons.some((reason) =>
    /퇴사|휴직|RETIRED|LEAVE|재직상태 아님/i.test(reason)
  );
  return [
    {
      code: inactive ? "INACTIVE" : "UNAVAILABLE",
      message: `${reasons.join(", ")} — 특수배치 강행 안 함`,
    },
  ];
}

export function annotateSpecialDutyConflicts(
  records: readonly SpecialDutyRecord[],
  unavailableById: ReadonlyMap<number, string[]>
): Array<SpecialDutyRecord & { conflicts: SpecialDutyConflict[] }> {
  return records.map((row) => {
    const conflicts = [
      ...detectCrossKindConflicts(records, row.kind, row.caddyId),
      ...detectUnavailableConflicts(row.caddyId, unavailableById),
    ];
    return { ...row, conflicts };
  });
}

export function unavailableReasonsFromRows(
  rows: Array<{ id: number; excludedReasons?: string[] | null; bucket?: string }>
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of rows) {
    if (row.bucket && row.bucket !== "excluded") continue;
    const reasons = (row.excludedReasons || []).filter(Boolean);
    if (reasons.length) map.set(row.id, reasons);
  }
  return map;
}

export type SpecialNameResolve = {
  matched: Array<{ caddyId: number; name: string }>;
  reviews: NameMatchResult[];
};

export function resolvePastedSpecialNames(
  namesText: unknown,
  caddies: readonly NameMatchCaddy[]
): SpecialNameResolve {
  const matched: Array<{ caddyId: number; name: string }> = [];
  const reviews: NameMatchResult[] = [];
  const seenIds = new Set<number>();
  for (const name of splitPastedSpecialNames(namesText)) {
    const hit = matchCaddyByExactName(name, caddies);
    if (hit.status === "matched") {
      if (seenIds.has(hit.caddyId)) continue;
      seenIds.add(hit.caddyId);
      matched.push({ caddyId: hit.caddyId, name: hit.name });
      continue;
    }
    reviews.push(hit);
  }
  return { matched, reviews };
}

export type EngineSpecialCaddy = AutoAssignCaddy & { inputOrder: number };

export type EngineSpecialBundles = {
  /** null = 해당 유형 관리자 입력 없음 → 기존 태그 추출 유지 */
  fiftyFourHole: EngineSpecialCaddy[] | null;
  oneThreeCandidates: EngineSpecialCaddy[] | null;
  oneTwoCandidates: EngineSpecialCaddy[] | null;
  oneMakCandidates: EngineSpecialCaddy[] | null;
  extraSpecial: EngineSpecialCaddy[];
  skipFromAvailableIds: number[];
  skippedPlacements: Array<{
    kind: DailySpecialKind;
    caddyId: number;
    name?: string;
    reasons: string[];
  }>;
};

function toEngineCaddy(row: SpecialDutyRecord): EngineSpecialCaddy {
  return {
    id: row.caddyId,
    name: row.name || `CADDY#${row.caddyId}`,
    team: row.team || "",
    teamOrder: Number(row.teamOrder) || 0,
    caddyType: row.caddyType ?? undefined,
    inputOrder: row.sortOrder,
  };
}

function eligibleForEngine(
  row: SpecialDutyRecord,
  unavailableById: ReadonlyMap<number, string[]>
): boolean {
  return !unavailableById.has(row.caddyId);
}

function orderedKind(
  records: readonly SpecialDutyRecord[],
  kind: DailySpecialKind
): SpecialDutyRecord[] {
  return records
    .filter((row) => row.kind === kind)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.caddyId - b.caddyId);
}

/**
 * 관리자 입력을 기존 autoAssign 입력 슬롯에 연결.
 * 같은 유형 내부 순서는 sortOrder 그대로. 유형 간 우선순위는 엔진이 유지.
 */
export function buildEngineSpecialBundles(
  records: readonly SpecialDutyRecord[],
  unavailableById: ReadonlyMap<number, string[]>
): EngineSpecialBundles {
  const skippedPlacements: EngineSpecialBundles["skippedPlacements"] = [];
  const skip = new Set<number>();

  function pick(
    kind: DailySpecialKind
  ): EngineSpecialCaddy[] | null {
    const rows = orderedKind(records, kind);
    if (!rows.length) return null;
    const eligible: EngineSpecialCaddy[] = [];
    for (const row of rows) {
      if (!eligibleForEngine(row, unavailableById)) {
        skippedPlacements.push({
          kind,
          caddyId: row.caddyId,
          name: row.name,
          reasons: unavailableById.get(row.caddyId) || [],
        });
        continue;
      }
      const caddy = toEngineCaddy(row);
      eligible.push(caddy);
      skip.add(caddy.id);
    }
    return eligible;
  }

  const fiftyFourHole = pick("FIFTY_FOUR");
  const oneThreeCandidates = pick("ONE_THREE");
  const oneTwoCandidates = pick("ONE_TWO");
  const oneMakCandidates = pick("ONE_MAK");
  const chageun = pick("CHAGEUN") || [];

  return {
    fiftyFourHole,
    oneThreeCandidates,
    oneTwoCandidates,
    oneMakCandidates,
    extraSpecial: chageun,
    skipFromAvailableIds: [...skip],
    skippedPlacements,
  };
}

export function applyBundlesToAssignPools<T extends { id: number }>(input: {
  available: T[];
  special: T[];
  extraSpecial: EngineSpecialCaddy[];
  skipFromAvailableIds: readonly number[];
}): { available: T[]; special: Array<T | EngineSpecialCaddy> } {
  const skip = new Set(input.skipFromAvailableIds);
  const available = input.available.filter((row) => !skip.has(row.id));
  const special: Array<T | EngineSpecialCaddy> = [...input.special];
  const seen = new Set(special.map((row) => row.id));
  for (const extra of input.extraSpecial) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    special.push(extra);
  }
  return { available, special };
}
