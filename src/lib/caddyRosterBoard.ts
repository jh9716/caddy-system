/**
 * /manage/caddies 현장표(엑셀형) 순수 헬퍼.
 * 컬럼/검색/밀도 헬퍼만 담당. 배치 편집 드래그와 Preview/Apply 는
 * caddyRosterReassignDraft / caddyReassignClient 가 맡는다.
 */
import {
  DRIVING_POOL_TEAM,
  HOUSE_TEAMS,
  PRIMARY_TEAMS,
  THIRD_BAND_SUBGROUP_LABELS,
  THIRD_BAND_TEAMS,
  countsTowardRosterHeadcount,
  isDrivingCaddyType,
  normalizeEmploymentStatus,
  rosterHeadcount,
  type ThirdBandSubgroup,
} from "@/lib/caddyManage";

export const ROSTER_TEAMS = PRIMARY_TEAMS;
export const ROSTER_HOUSE_LABEL = "하우스";
export const ROSTER_THIRD_LABEL = "3부반";
export const ROSTER_DRIVING_LABEL = "드라이빙";

export type RosterBoardCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus?: string | null;
  caddyType?: string | null;
  thirdBandSubgroup?: ThirdBandSubgroup | null;
};

export type RosterBoardColumn = {
  key: string;
  title: string;
  band: "HOUSE" | "THIRD" | "DRIVING";
  count: number;
  driving: boolean;
  members: RosterBoardCaddy[];
};

export type RosterTeamSummary = {
  team: string;
  total: number;
  active: number;
  leave: number;
  retired: number;
  other: number;
};

/**
 * 현장 엑셀 색(조장 노랑 / 기숙사 카트 주황 / 1·3부 파랑)은
 * 명단 SoT가 없어 표시하지 않는다. 추측 색·신규 상태 저장 금지.
 *
 * - 조장: User.role=leader / managedTeams / 날짜별 DailyOpsDuty.LEADER.
 *   Caddy에 고정 조장 플래그 없음.
 * - 기숙사 카트: Cart.dormitoryOnly 는 카트 마스터 SoT.
 *   기숙사 전용 카트는 고정 주인 불가(owner XOR). DailyCartAssignment 미구현.
 *   Caddy.dormitoryResident 는 거주 자격이며 카트와 다름.
 * - 1·3부 신청: DailySpecialDuty 는 날짜별 관리자 입력.
 *   주중/주말(thirdBandSubgroup)과 다른 개념.
 */
export const ROSTER_FIELD_COLOR_POLICY = {
  leaderYellow: false,
  dormCartOrange: false,
  oneThreeApplicantBlue: false,
} as const;

export function isRosterDrivingCaddy(c: {
  caddyType?: string | null;
  team?: string | null;
}): boolean {
  return isDrivingCaddyType(c.caddyType) || c.team === DRIVING_POOL_TEAM;
}

export function rosterPersonName(c: { name?: string | null }): string {
  return String(c.name ?? "").trim() || "이름없음";
}

/** 1 이상만 조 내 고정 슬롯. 0/빈값/비정수는 미지정. DB 값은 바꾸지 않는다. */
export function hasAssignedRosterSlot(teamOrder: unknown): boolean {
  const n = Number(teamOrder);
  return Number.isInteger(n) && n >= 1;
}

/** 화면 표시용. 미지정은 "—" 이며 0을 순번처럼 보이지 않게 한다. */
export function rosterSlotDisplay(teamOrder: unknown): string {
  if (!hasAssignedRosterSlot(teamOrder)) return "—";
  return String(Math.floor(Number(teamOrder)));
}

export type RosterDensity = "compact" | "normal";

export function normalizeRosterDensity(input: unknown): RosterDensity {
  return String(input ?? "").trim() === "normal" ? "normal" : "compact";
}

/** 압축 보기 컬럼 하한(px). 86은 이름 1글자 세로 줄바꿈. 112~120 중 116.
 * 13×116=1508 → 1920 본문(~1634)은 한 화면, 1366은 가로 스크롤. */
export const ROSTER_COMPACT_COL_MIN_PX = 116;
export const ROSTER_NORMAL_COL_MIN_PX = 168;
export const ROSTER_SHEET_COL_COUNT = 13;

export function rosterQueryMatches(
  c: { id: number; name?: string | null },
  query: string
): boolean {
  const q = String(query ?? "").trim();
  if (!q) return true;
  return String(c.name ?? "").includes(q) || String(c.id).includes(q);
}

export function rosterSubgroupLabel(
  value: ThirdBandSubgroup | null | undefined
): string | null {
  if (value === "WEEKDAY") return THIRD_BAND_SUBGROUP_LABELS.WEEKDAY;
  if (value === "WEEKEND") return THIRD_BAND_SUBGROUP_LABELS.WEEKEND;
  return null;
}

export function buildRosterTeamSummaries(
  rows: RosterBoardCaddy[]
): RosterTeamSummary[] {
  const map = new Map<string, RosterTeamSummary>(
    PRIMARY_TEAMS.map((team) => [
      team,
      { team, total: 0, active: 0, leave: 0, retired: 0, other: 0 },
    ])
  );
  for (const r of rows) {
    if (isRosterDrivingCaddy(r)) continue;
    const cur = map.get(r.team);
    if (!cur) continue;
    const st = normalizeEmploymentStatus(r.employmentStatus);
    if (st === "ACTIVE") cur.active += 1;
    else if (st === "LEAVE") cur.leave += 1;
    else if (st === "RETIRED") cur.retired += 1;
    else cur.other += 1;
    if (countsTowardRosterHeadcount(r.employmentStatus)) cur.total += 1;
  }
  return PRIMARY_TEAMS.map((t) => map.get(t)!);
}

export function buildRosterColumns(input: {
  rows: RosterBoardCaddy[];
  query?: string;
  drivingHeadcount?: number;
}): RosterBoardColumn[] {
  const query = String(input.query ?? "").trim();
  const summaries = buildRosterTeamSummaries(input.rows);
  const columns: RosterBoardColumn[] = PRIMARY_TEAMS.map((team) => {
    const summary = summaries.find((t) => t.team === team);
    const members = input.rows
      .filter(
        (r) =>
          !isRosterDrivingCaddy(r) &&
          r.team === team &&
          normalizeEmploymentStatus(r.employmentStatus) !== "RETIRED"
      )
      .filter((r) => rosterQueryMatches(r, query))
      .sort((a, b) => a.teamOrder - b.teamOrder || a.id - b.id);
    return {
      key: team,
      title: team,
      band: HOUSE_TEAMS.includes(team as (typeof HOUSE_TEAMS)[number])
        ? "HOUSE"
        : "THIRD",
      count: summary?.total ?? 0,
      driving: false,
      members,
    };
  });
  const drivingMembers = input.rows
    .filter(
      (r) =>
        isRosterDrivingCaddy(r) &&
        normalizeEmploymentStatus(r.employmentStatus) !== "RETIRED"
    )
    .filter((r) => rosterQueryMatches(r, query))
    .sort((a, b) => a.name.localeCompare(b.name, "ko") || a.id - b.id);
  const drivingHeadcount =
    input.drivingHeadcount ??
    rosterHeadcount(input.rows.filter((r) => isRosterDrivingCaddy(r)));
  columns.push({
    key: DRIVING_POOL_TEAM,
    title: ROSTER_DRIVING_LABEL,
    band: "DRIVING",
    count: drivingHeadcount,
    driving: true,
    members: drivingMembers,
  });
  return columns;
}

export type OwnedCartLike = {
  ownerCaddyId?: number | null;
  number?: string | null;
  dormitoryOnly?: boolean | null;
};

/**
 * 고정 주인 카트만. 기숙사 전용(dormitoryOnly)은 주인 불가이므로 제외.
 * 날짜 배정 카트는 아직 없으므로 추정하지 않는다.
 */
export function ownedCartNumberByCaddyId(
  carts: OwnedCartLike[] | null | undefined
): Record<number, string> {
  const map: Record<number, string> = {};
  if (!Array.isArray(carts)) return map;
  for (const cart of carts) {
    if (cart?.dormitoryOnly === true) continue;
    const id = Number(cart?.ownerCaddyId);
    if (!Number.isInteger(id) || id < 1) continue;
    const number = String(cart?.number ?? "").trim();
    if (!number) continue;
    map[id] = number;
  }
  return map;
}

export const MOBILE_ROSTER_KEYS = [
  ...PRIMARY_TEAMS,
  DRIVING_POOL_TEAM,
] as const;

export function normalizeMobileRosterKey(input: unknown): string {
  const raw = String(input ?? "").trim();
  if ((MOBILE_ROSTER_KEYS as readonly string[]).includes(raw)) return raw;
  return "1조";
}

export type MobileRosterRow = RosterBoardCaddy & {
  columnKey: string;
  columnTitle: string;
  driving: boolean;
};

/**
 * 모바일: 검색어가 있으면 전 조에서 찾고, 없으면 선택한 조만 보여준다.
 * 12개 조를 가로로 축소하지 않기 위한 목록 소스.
 */
export function listMobileRosterRows(input: {
  columns: RosterBoardColumn[];
  selectedKey: string;
  query?: string;
}): MobileRosterRow[] {
  const query = String(input.query ?? "").trim();
  const selected = normalizeMobileRosterKey(input.selectedKey);
  const rows: MobileRosterRow[] = [];
  for (const col of input.columns) {
    if (!query && col.key !== selected) continue;
    for (const member of col.members) {
      rows.push({
        ...member,
        columnKey: col.key,
        columnTitle: col.title,
        driving: col.driving,
      });
    }
  }
  return rows;
}

export function rosterBandOfTeam(team: string): "HOUSE" | "THIRD" | "DRIVING" {
  if (team === DRIVING_POOL_TEAM) return "DRIVING";
  if ((THIRD_BAND_TEAMS as readonly string[]).includes(team)) return "THIRD";
  return "HOUSE";
}
