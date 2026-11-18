/**
 * 3부반 주간 시작조 순환.
 * teamOrder 필드는 수정하지 않고, 그날 THIRD queue 정렬에만 사용.
 * 조 번호가 아니라 날짜별 조 설정 스냅샷의 운영 THIRD 조를 사용한다.
 */

import { THIRD_BAND_TEAMS, type ThirdBandTeam } from "@/lib/caddyManage";
import { addDays, weekdaySun0 } from "@/lib/krHolidays";
import {
  DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  isThirdAffiliatedTeam,
  thirdTeamsInSnapshot,
  type TeamAffiliationSnapshot,
} from "@/lib/teamAffiliation";

export type ThirdQueueCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string | null;
  thirdBandSubgroup?: string | null;
  extraFlags?: string[] | null;
};

/** 2026-08-17(월) 주 = 12조 스타트 */
export const THIRD_WEEKLY_ANCHOR_MONDAY = "2026-08-17";
export const THIRD_WEEKLY_ANCHOR_START: ThirdBandTeam = "12조";

/** 앵커 주부터의 순환 순서: 12 → 9 → 10 → 11 → 12 */
export const THIRD_WEEKLY_CYCLE: readonly ThirdBandTeam[] = [
  "12조",
  "9조",
  "10조",
  "11조",
];

export function isThirdWeeklyTeam(
  value: unknown,
  snapshot?: TeamAffiliationSnapshot | null
): boolean {
  const team = String(value ?? "").trim();
  if (snapshot) return isThirdAffiliatedTeam(team, snapshot);
  return (THIRD_BAND_TEAMS as readonly string[]).includes(team);
}

export function thirdRotationTeams(
  snapshot?: TeamAffiliationSnapshot | null
): string[] {
  const teams = thirdTeamsInSnapshot(snapshot ?? DEFAULT_TEAM_AFFILIATION_SNAPSHOT);
  if (teams.length === 0) return [...THIRD_BAND_TEAMS];
  const cycle = THIRD_WEEKLY_CYCLE.filter((team) => teams.includes(team));
  const extra = teams.filter((team) => !cycle.includes(team as ThirdBandTeam));
  return cycle.length > 0 ? [...cycle, ...extra] : teams;
}

export function mondayOfWeek(ymd: string): string {
  const wd = weekdaySun0(ymd); // 0=일
  const delta = wd === 0 ? -6 : 1 - wd;
  return addDays(ymd, delta);
}

function utcDay(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function weeksFromAnchorMonday(weekMonday: string): number {
  const a = utcDay(THIRD_WEEKLY_ANCHOR_MONDAY);
  const b = utcDay(weekMonday);
  return Math.round((b - a) / 7);
}

export function automaticThirdStartTeam(ymd: string): ThirdBandTeam {
  const monday = mondayOfWeek(ymd);
  const weeks = weeksFromAnchorMonday(monday);
  const idx = ((weeks % 4) + 4) % 4;
  return THIRD_WEEKLY_CYCLE[idx];
}

function firstOperationalThirdInCycle(
  preferred: string,
  snapshot?: TeamAffiliationSnapshot | null
): string {
  const teams = thirdTeamsInSnapshot(snapshot ?? DEFAULT_TEAM_AFFILIATION_SNAPSHOT);
  if (teams.includes(preferred as (typeof teams)[number])) return preferred;
  const start = THIRD_WEEKLY_CYCLE.indexOf(preferred as ThirdBandTeam);
  const cycle =
    start >= 0
      ? [
          ...THIRD_WEEKLY_CYCLE.slice(start),
          ...THIRD_WEEKLY_CYCLE.slice(0, start),
        ]
      : [...THIRD_WEEKLY_CYCLE];
  for (const team of cycle) {
    if (teams.includes(team)) return team;
  }
  return teams[0] ?? preferred;
}

/** override는 그 주 월요일과 일치할 때만 적용. 이후 주차는 자동값. */
export function effectiveThirdStartTeam(
  ymd: string,
  override?: { weekStart: string; startTeam: string } | null,
  snapshot?: TeamAffiliationSnapshot | null
): ThirdBandTeam {
  const monday = mondayOfWeek(ymd);
  if (
    override &&
    override.weekStart === monday &&
    isThirdWeeklyTeam(override.startTeam, snapshot)
  ) {
    return firstOperationalThirdInCycle(
      override.startTeam,
      snapshot
    ) as ThirdBandTeam;
  }
  return firstOperationalThirdInCycle(
    automaticThirdStartTeam(ymd),
    snapshot
  ) as ThirdBandTeam;
}

export function resolveThirdStartTeam(
  raw: unknown,
  ymd: string,
  snapshot?: TeamAffiliationSnapshot | null
): ThirdBandTeam {
  const value = String(raw ?? "").trim();
  if (isThirdWeeklyTeam(value, snapshot)) {
    return firstOperationalThirdInCycle(value, snapshot) as ThirdBandTeam;
  }
  return firstOperationalThirdInCycle(
    automaticThirdStartTeam(ymd),
    snapshot
  ) as ThirdBandTeam;
}

/** 시작조 기준 운영 THIRD 순환. 기본 9~12면 12스타트 → 12,9,10,11 */
export function rotateThirdTeamsFromStart(
  startTeam: ThirdBandTeam | string,
  snapshot?: TeamAffiliationSnapshot | null
): string[] {
  const all = thirdRotationTeams(snapshot);
  const i = all.indexOf(String(startTeam ?? "").trim());
  if (i < 0) return all;
  return [...all.slice(i), ...all.slice(0, i)];
}

function teamCycleRank(
  team: string,
  startTeam: ThirdBandTeam | string,
  snapshot?: TeamAffiliationSnapshot | null
): number {
  const order = rotateThirdTeamsFromStart(startTeam, snapshot);
  const idx = order.indexOf(String(team ?? "").trim());
  return idx >= 0 ? idx : 1000;
}

function compareFallbackCaddy(
  a: ThirdQueueCaddy,
  b: ThirdQueueCaddy
): number {
  if (a.team !== b.team) return a.team.localeCompare(b.team, "ko");
  if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
  return a.id - b.id;
}

/**
 * THIRD 가용 queue: 9~12조는 주간 시작조 순환, 그 외 THIRD는 기존 조순 뒤쪽.
 * teamOrder 값은 그대로 두고 비교만 한다.
 */
export function rotateThirdQueueFromStartTeam<T extends ThirdQueueCaddy>(
  third: readonly T[],
  startTeam: ThirdBandTeam | string,
  snapshot?: TeamAffiliationSnapshot | null
): T[] {
  const band: T[] = [];
  const rest: T[] = [];
  for (const caddy of third) {
    if (isThirdWeeklyTeam(caddy.team, snapshot)) band.push(caddy);
    else rest.push(caddy);
  }
  band.sort((a, b) => {
    const tr =
      teamCycleRank(a.team, startTeam, snapshot) -
      teamCycleRank(b.team, startTeam, snapshot);
    if (tr !== 0) return tr;
    if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
    return a.id - b.id;
  });
  rest.sort(compareFallbackCaddy);
  return [...band, ...rest];
}

/**
 * 주간 9~12조 회전 큐에서 startCaddyId부터 잘라 regular 가용 THIRD를 재배열.
 * start 캐디가 가용 풀에 없으면 그 다음 방향으로 풀에 있는 첫 사람을 쓴다 (wrap).
 * teamOrder 값은 수정하지 않는다. id 유효성(존재/9~12조)은 호출측에서 검사한다.
 */
export function rotateThirdQueueFromStartCaddy<T extends ThirdQueueCaddy>(
  availableThird: readonly T[],
  startCaddyId: number,
  roster: readonly T[],
  startTeam: ThirdBandTeam | string,
  snapshot?: TeamAffiliationSnapshot | null
): T[] {
  const available = rotateThirdQueueFromStartTeam(
    availableThird,
    startTeam,
    snapshot
  );
  if (available.length === 0) return [];
  const canonical = rotateThirdQueueFromStartTeam(
    roster.filter((caddy) => isThirdWeeklyTeam(caddy.team, snapshot)),
    startTeam,
    snapshot
  );
  const availableIds = new Set(available.map((caddy) => caddy.id));
  let idx = canonical.findIndex((caddy) => caddy.id === startCaddyId);
  if (idx < 0) {
    idx = available.findIndex((caddy) => caddy.id === startCaddyId);
    if (idx < 0) return available;
    return [...available.slice(idx), ...available.slice(0, idx)];
  }
  for (let i = 0; i < canonical.length; i++) {
    const cand = canonical[(idx + i) % canonical.length];
    if (!availableIds.has(cand.id)) continue;
    const ai = available.findIndex((caddy) => caddy.id === cand.id);
    if (ai < 0) continue;
    if (ai === 0) return available;
    return [...available.slice(ai), ...available.slice(0, ai)];
  }
  return available;
}

export function isWeekendBandCaddy(caddy: {
  thirdBandSubgroup?: string | null;
  extraFlags?: string[] | null;
}): boolean {
  return String(caddy.thirdBandSubgroup || "").toUpperCase() === "WEEKEND";
}

export function isWeekdayBandCaddy(caddy: {
  thirdBandSubgroup?: string | null;
  extraFlags?: string[] | null;
}): boolean {
  return String(caddy.thirdBandSubgroup || "").toUpperCase() === "WEEKDAY";
}

/** 주간 THIRD rotation 안에서 WEEKEND만 상대순서 유지하며 추출 */
export function extractWeekendBandInRotationOrder<T extends ThirdQueueCaddy>(
  rotatedThird: readonly T[]
): T[] {
  return rotatedThird.filter((caddy) => isWeekendBandCaddy(caddy));
}

/** 주간 THIRD rotation 안에서 WEEKDAY만 상대순서 유지하며 추출 */
export function extractWeekdayBandInRotationOrder<T extends ThirdQueueCaddy>(
  rotatedThird: readonly T[]
): T[] {
  return rotatedThird.filter((caddy) => isWeekdayBandCaddy(caddy));
}
