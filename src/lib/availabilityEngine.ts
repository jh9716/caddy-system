/**
 * 가용 캐디 계산 엔진 (1단계)
 * - 순수 함수: DB/네트워크 없음
 * - 자동배치(2단계)는 이 결과의 available/special 을 입력으로 사용
 */

import { PRIMARY_TEAMS, type ExtraFlagOption } from "@/lib/caddyManage";

export type CaddyTypeCode = "HOUSE" | "THIRD" | "DRIVING";
export type EmploymentCode = "ACTIVE" | "LEAVE" | "RETIRED";

/** 일반 배치에서 제외하는 Assignment 타입 */
export const BLOCKING_ASSIGNMENT_TYPES = [
  "OFF",
  "SICK",
  "LONG_SICK",
  "DUTY",
  "MARSHAL",
  "ACCIDENT",
  "FAMILY_EVENT",
] as const;
export type BlockingAssignmentType = (typeof BLOCKING_ASSIGNMENT_TYPES)[number];

const BLOCKING_SET = new Set<string>(BLOCKING_ASSIGNMENT_TYPES);

/** 특별찾근/고정배치로 일반 가용과 분리할 태그·서브타입 힌트 */
export const SPECIAL_PLACEMENT_HINTS = [
  "찾근",
  "특별찾근",
  "특별",
  "고정",
  "고정배치",
  "고정카트",
  "1·3",
  "1·2",
  "13",
  "12",
  "54",
  "외곽",
] as const;

export type AvailabilityCaddyInput = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: EmploymentCode | string;
  caddyType?: CaddyTypeCode | string | null;
  extraFlags?: string[] | null;
};

export type AvailabilityAssignmentInput = {
  caddyId: number;
  type: string;
  subType?: string | null;
  startDate: Date | string;
  endDate: Date | string;
};

export type AvailabilityExtraTagInput = {
  caddyId: number;
  tag: string;
  date?: Date | string;
};

export type AvailabilityBucket = "available" | "special" | "excluded";

export type AvailabilityRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType: CaddyTypeCode;
  extraFlags: ExtraFlagOption[];
  bucket: AvailabilityBucket;
  excludedReasons: string[];
  specialTags: string[];
  assignmentLabels: string[];
};

export type AvailabilityResult = {
  date: string;
  /** 일반 가용 (HOUSE/THIRD/DRIVING 구분, 조·순번 정렬) */
  available: {
    all: AvailabilityRow[];
    byType: Record<CaddyTypeCode, AvailabilityRow[]>;
    byTeam: Array<{ team: string; rows: AvailabilityRow[] }>;
  };
  /** 특별찾근/고정배치 등 — 일반 순번과 분리 */
  special: AvailabilityRow[];
  /** 제외 (사유 포함) */
  excluded: AvailabilityRow[];
  counts: {
    available: number;
    special: number;
    excluded: number;
    byType: Record<CaddyTypeCode, number>;
  };
};

const ASSIGNMENT_LABEL: Record<string, string> = {
  OFF: "휴무",
  SICK: "병가",
  LONG_SICK: "장기병가",
  DUTY: "당번",
  MARSHAL: "마샬",
  ACCIDENT: "타구사고",
  FAMILY_EVENT: "경조사",
};

export function parseYmd(ymd: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const start = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(start.getTime())) throw new Error("invalid date");
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("invalid datetime");
  return d;
}

export function assignmentOverlapsDay(
  assignment: Pick<AvailabilityAssignmentInput, "startDate" | "endDate">,
  dayStart: Date,
  dayEnd: Date
): boolean {
  const start = toDate(assignment.startDate);
  const end = toDate(assignment.endDate);
  return start <= dayEnd && end >= dayStart;
}

export function normalizeCaddyType(input: unknown): CaddyTypeCode {
  const v = String(input ?? "HOUSE").trim().toUpperCase();
  if (v === "THIRD") return "THIRD";
  if (v === "DRIVING") return "DRIVING";
  return "HOUSE";
}

export function isSpecialPlacementText(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return SPECIAL_PLACEMENT_HINTS.some((hint) =>
    t.includes(hint.toLowerCase())
  );
}

function teamRank(team: string): number {
  const idx = (PRIMARY_TEAMS as readonly string[]).indexOf(team);
  if (idx >= 0) return idx;
  // 주중반/주말반/드라이빙 등 primary 외 팀은 뒤로
  return PRIMARY_TEAMS.length + 100;
}

export function compareAvailabilityRows(a: AvailabilityRow, b: AvailabilityRow): number {
  const tr = teamRank(a.team) - teamRank(b.team);
  if (tr !== 0) return tr;
  if (a.team !== b.team) return a.team.localeCompare(b.team, "ko");
  if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
  return a.id - b.id;
}

function assignmentLabel(type: string, subType?: string | null): string {
  const base = ASSIGNMENT_LABEL[type] ?? type;
  return subType ? `${base}(${subType})` : base;
}

/**
 * 날짜 기준 가용 캐디 계산 (순수 함수).
 * 동일 id는 한 번만 결과에 포함된다.
 */
export function computeAvailability(input: {
  date: string;
  caddies: AvailabilityCaddyInput[];
  assignments?: AvailabilityAssignmentInput[];
  extraTags?: AvailabilityExtraTagInput[];
}): AvailabilityResult {
  const { date } = input;
  const { start, end } = parseYmd(date);

  const byId = new Map<number, AvailabilityCaddyInput>();
  for (const c of input.caddies) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }

  const assignmentsByCaddy = new Map<number, AvailabilityAssignmentInput[]>();
  for (const a of input.assignments ?? []) {
    if (!assignmentOverlapsDay(a, start, end)) continue;
    const list = assignmentsByCaddy.get(a.caddyId) ?? [];
    list.push(a);
    assignmentsByCaddy.set(a.caddyId, list);
  }

  const tagsByCaddy = new Map<number, string[]>();
  for (const t of input.extraTags ?? []) {
    if (t.date != null) {
      const d = toDate(t.date);
      if (d < start || d > end) continue;
    }
    const list = tagsByCaddy.get(t.caddyId) ?? [];
    const tag = String(t.tag ?? "").trim();
    if (tag && !list.includes(tag)) list.push(tag);
    tagsByCaddy.set(t.caddyId, list);
  }

  const available: AvailabilityRow[] = [];
  const special: AvailabilityRow[] = [];
  const excluded: AvailabilityRow[] = [];

  for (const c of byId.values()) {
    const employment = String(c.employmentStatus ?? "").toUpperCase();
    const caddyType = normalizeCaddyType(c.caddyType);
    const extraFlags = (c.extraFlags ?? []).filter(
      (f): f is ExtraFlagOption =>
        f === "주중반" || f === "주말반" || f === "드라이빙"
    );
    const dayAssignments = assignmentsByCaddy.get(c.id) ?? [];
    const specialTags = tagsByCaddy.get(c.id) ?? [];
    const assignmentLabels = dayAssignments.map((a) =>
      assignmentLabel(a.type, a.subType)
    );

    const reasons: string[] = [];

    if (employment === "RETIRED") reasons.push("퇴사(RETIRED)");
    else if (employment === "LEAVE") reasons.push("휴직(LEAVE)");
    else if (employment !== "ACTIVE") {
      reasons.push(`재직상태 아님(${employment || "UNKNOWN"})`);
    }

    const blocking = dayAssignments.filter((a) => BLOCKING_SET.has(a.type));
    for (const a of blocking) {
      reasons.push(assignmentLabel(a.type, a.subType));
    }

    // 특별 힌트: 태그 또는 assignment subType
    const specialFromSubtype = dayAssignments
      .map((a) => a.subType || "")
      .filter((s) => isSpecialPlacementText(s));
    const specialFromTags = specialTags.filter((t) => isSpecialPlacementText(t));
    const specialMarks = Array.from(
      new Set([...specialFromSubtype, ...specialFromTags])
    );
    const isSpecial = specialMarks.length > 0;

    const baseRow: AvailabilityRow = {
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: Number(c.teamOrder) || 0,
      caddyType,
      extraFlags,
      bucket: "excluded",
      excludedReasons: [],
      specialTags: specialMarks,
      assignmentLabels,
    };

    if (reasons.length > 0) {
      excluded.push({
        ...baseRow,
        bucket: "excluded",
        excludedReasons: reasons,
      });
      continue;
    }

    if (isSpecial) {
      special.push({
        ...baseRow,
        bucket: "special",
        excludedReasons: [],
      });
      continue;
    }

    available.push({
      ...baseRow,
      bucket: "available",
      excludedReasons: [],
    });
  }

  available.sort(compareAvailabilityRows);
  special.sort(compareAvailabilityRows);
  excluded.sort(compareAvailabilityRows);

  const byType: Record<CaddyTypeCode, AvailabilityRow[]> = {
    HOUSE: [],
    THIRD: [],
    DRIVING: [],
  };
  for (const row of available) byType[row.caddyType].push(row);

  const teamMap = new Map<string, AvailabilityRow[]>();
  for (const row of available) {
    const list = teamMap.get(row.team) ?? [];
    list.push(row);
    teamMap.set(row.team, list);
  }
  const teamKeys = Array.from(teamMap.keys()).sort(
    (a, b) => teamRank(a) - teamRank(b) || a.localeCompare(b, "ko")
  );
  const byTeam = teamKeys.map((team) => ({
    team,
    rows: teamMap.get(team) ?? [],
  }));

  return {
    date,
    available: { all: available, byType, byTeam },
    special,
    excluded,
    counts: {
      available: available.length,
      special: special.length,
      excluded: excluded.length,
      byType: {
        HOUSE: byType.HOUSE.length,
        THIRD: byType.THIRD.length,
        DRIVING: byType.DRIVING.length,
      },
    },
  };
}
