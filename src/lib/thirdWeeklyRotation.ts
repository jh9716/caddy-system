/**
 * 3부반(9~12조) 주간 시작조 순환.
 * teamOrder 필드는 수정하지 않고, 그날 THIRD queue 정렬에만 사용.
 */

import { THIRD_BAND_TEAMS, type ThirdBandTeam } from "@/lib/caddyManage";
import { addDays, weekdaySun0 } from "@/lib/krHolidays";

export type ThirdQueueCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
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

export function isThirdWeeklyTeam(value: unknown): value is ThirdBandTeam {
  return (THIRD_BAND_TEAMS as readonly string[]).includes(String(value ?? "").trim());
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

/** override는 그 주 월요일과 일치할 때만 적용. 이후 주차는 자동값. */
export function effectiveThirdStartTeam(
  ymd: string,
  override?: { weekStart: string; startTeam: string } | null
): ThirdBandTeam {
  const monday = mondayOfWeek(ymd);
  if (
    override &&
    override.weekStart === monday &&
    isThirdWeeklyTeam(override.startTeam)
  ) {
    return override.startTeam;
  }
  return automaticThirdStartTeam(ymd);
}

export function resolveThirdStartTeam(
  raw: unknown,
  ymd: string
): ThirdBandTeam {
  const value = String(raw ?? "").trim();
  if (isThirdWeeklyTeam(value)) return value;
  return automaticThirdStartTeam(ymd);
}

/** 시작조 기준 9~12조 순환: 12스타트 → 12,9,10,11 */
export function rotateThirdTeamsFromStart(
  startTeam: ThirdBandTeam
): ThirdBandTeam[] {
  const all = [...THIRD_BAND_TEAMS];
  const i = all.indexOf(startTeam);
  if (i < 0) return all;
  return [...all.slice(i), ...all.slice(0, i)];
}

function teamCycleRank(team: string, startTeam: ThirdBandTeam): number {
  const order = rotateThirdTeamsFromStart(startTeam);
  const idx = order.indexOf(String(team ?? "").trim() as ThirdBandTeam);
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
  startTeam: ThirdBandTeam
): T[] {
  const band: T[] = [];
  const rest: T[] = [];
  for (const caddy of third) {
    if (isThirdWeeklyTeam(caddy.team)) band.push(caddy);
    else rest.push(caddy);
  }
  band.sort((a, b) => {
    const tr = teamCycleRank(a.team, startTeam) - teamCycleRank(b.team, startTeam);
    if (tr !== 0) return tr;
    if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
    return a.id - b.id;
  });
  rest.sort(compareFallbackCaddy);
  return [...band, ...rest];
}

export function isWeekendBandCaddy(caddy: {
  thirdBandSubgroup?: string | null;
  extraFlags?: string[] | null;
}): boolean {
  return String(caddy.thirdBandSubgroup || "").toUpperCase() === "WEEKEND";
}

/** 주간 THIRD rotation 안에서 WEEKEND만 상대순서 유지하며 추출 */
export function extractWeekendBandInRotationOrder<T extends ThirdQueueCaddy>(
  rotatedThird: readonly T[]
): T[] {
  return rotatedThird.filter((caddy) => isWeekendBandCaddy(caddy));
}
