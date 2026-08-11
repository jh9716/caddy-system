/**
 * 휴무 OffRequest 권한 — 순수 헬퍼 + Actor 타입
 *
 * - admin: 전 조 접근
 * - leader: User.managedTeams 에 포함된 조만 (복수 조·공동 조장 가능)
 * - caddy: 본인 caddyId 신청/조회/취소만
 */

import type { AppRole } from "@/lib/sessionCookies";

export type OffRequestActor = {
  role: AppRole;
  username: string;
  /** DB User.id — 환경변수 계정 등은 null */
  userId: number | null;
  /** 연결된 캐디 id */
  caddyId: number | null;
  /** leader 관리 조. admin은 이 값과 무관하게 전체 접근 */
  managedTeams: string[];
};

export function normalizeTeamName(team: unknown): string {
  return String(team ?? "").trim();
}

export function uniqueTeams(teams: unknown): string[] {
  if (!Array.isArray(teams)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of teams) {
    const n = normalizeTeamName(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** admin / leader 만 조 단위 목록·승인 가능 */
export function canManageOffRequests(actor: OffRequestActor): boolean {
  return actor.role === "admin" || actor.role === "leader";
}

/** 특정 조 접근 가능 여부 */
export function canAccessTeam(actor: OffRequestActor, team: string): boolean {
  const t = normalizeTeamName(team);
  if (!t) return false;
  if (actor.role === "admin") return true;
  if (actor.role === "leader") {
    return actor.managedTeams.some((x) => normalizeTeamName(x) === t);
  }
  return false;
}

/**
 * 목록/집계용 조 필터.
 * - admin + team 미지정 → null (전체)
 * - admin + team 지정 → [team]
 * - leader + team 미지정 → managedTeams 전체
 * - leader + team 지정 → 교집합(권한 있는 조만)
 */
export function resolveTeamFilter(
  actor: OffRequestActor,
  requestedTeam?: string | null
): { ok: true; teams: string[] | null } | { ok: false; error: string } {
  if (!canManageOffRequests(actor)) {
    return { ok: false, error: "forbidden" };
  }
  const want = requestedTeam ? normalizeTeamName(requestedTeam) : "";
  if (actor.role === "admin") {
    if (!want) return { ok: true, teams: null };
    return { ok: true, teams: [want] };
  }
  // leader
  const allowed = uniqueTeams(actor.managedTeams);
  if (allowed.length === 0) {
    return { ok: false, error: "no_managed_teams" };
  }
  if (!want) return { ok: true, teams: allowed };
  if (!allowed.includes(want)) {
    return { ok: false, error: "team_forbidden" };
  }
  return { ok: true, teams: [want] };
}

export function canSubmitOwnOffRequest(actor: OffRequestActor): boolean {
  return (
    (actor.role === "caddy" || actor.role === "leader" || actor.role === "admin") &&
    actor.caddyId != null
  );
}

export function isOwnCaddy(
  actor: OffRequestActor,
  caddyId: number
): boolean {
  return actor.caddyId != null && actor.caddyId === caddyId;
}
