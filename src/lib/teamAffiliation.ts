/**
 * 조 번호와 HOUSE/THIRD 소속을 분리하는 단일 기준.
 *
 * Caddy.caddyType 은 DRIVING 여부 + 개별 row 캐시의 denormalized 값이다.
 * 일반(1~12조) HOUSE/THIRD 판정은 이 모듈의 날짜별 스냅샷이 권위다.
 * 운영 명단·재직상태·확정 배치표는 여기서 수정하지 않는다.
 */

export const TEAM_AFFILIATION_TEAMS = [
  "1조",
  "2조",
  "3조",
  "4조",
  "5조",
  "6조",
  "7조",
  "8조",
  "9조",
  "10조",
  "11조",
  "12조",
] as const;

export type TeamAffiliationTeam = (typeof TEAM_AFFILIATION_TEAMS)[number];

export const DEFAULT_HOUSE_TEAMS = [
  "1조",
  "2조",
  "3조",
  "4조",
  "5조",
  "6조",
  "7조",
  "8조",
] as const;

export const DEFAULT_THIRD_TEAMS = ["9조", "10조", "11조", "12조"] as const;

export type TeamAffiliationKind = "HOUSE" | "THIRD";
export type TeamOperationalKind = "ACTIVE" | "INACTIVE";

export type TeamAffiliationRow = {
  team: TeamAffiliationTeam;
  affiliation: TeamAffiliationKind;
  operational: boolean;
};

export type TeamAffiliationSnapshot = {
  date: string;
  effectiveFrom: string | null;
  source: "default" | "version";
  versionId: number | null;
  rows: TeamAffiliationRow[];
};

export type TeamAffiliationVersionInput = {
  effectiveFrom: string;
  note?: string | null;
  teams: Array<{
    team: string;
    affiliation: string;
    operational: boolean;
  }>;
};

export class TeamAffiliationError extends Error {
  status = 400;
  code = "team_affiliation_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "TeamAffiliationError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

export function isTeamAffiliationTeam(
  value: unknown
): value is TeamAffiliationTeam {
  return (TEAM_AFFILIATION_TEAMS as readonly string[]).includes(
    String(value ?? "").trim()
  );
}

export function parseTeamAffiliationYmd(value: unknown): string {
  const ymd = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new TeamAffiliationError("적용일은 YYYY-MM-DD 형식이어야 합니다.");
  }
  return ymd;
}

function emptyRows(): TeamAffiliationRow[] {
  return TEAM_AFFILIATION_TEAMS.map((team) => ({
    team,
    affiliation: (DEFAULT_THIRD_TEAMS as readonly string[]).includes(team)
      ? "THIRD"
      : "HOUSE",
    operational: true,
  }));
}

/** 설정이 없을 때: 1~8 HOUSE, 9~12 THIRD, 전원 운영. 운영 데이터 전환을 자동 적용하지 않는다. */
export function defaultTeamAffiliationSnapshot(
  date = "1970-01-01"
): TeamAffiliationSnapshot {
  return {
    date,
    effectiveFrom: null,
    source: "default",
    versionId: null,
    rows: emptyRows(),
  };
}

export const DEFAULT_TEAM_AFFILIATION_SNAPSHOT =
  defaultTeamAffiliationSnapshot();

export function cloneTeamAffiliationSnapshot(
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationSnapshot {
  const src = snapshot ?? DEFAULT_TEAM_AFFILIATION_SNAPSHOT;
  return {
    date: src.date,
    effectiveFrom: src.effectiveFrom,
    source: src.source,
    versionId: src.versionId,
    rows: src.rows.map((row) => ({ ...row })),
  };
}

export function snapshotFromRows(
  date: string,
  rows: readonly TeamAffiliationRow[],
  meta?: {
    effectiveFrom?: string | null;
    source?: "default" | "version";
    versionId?: number | null;
  }
): TeamAffiliationSnapshot {
  const byTeam = new Map(rows.map((row) => [row.team, row]));
  const merged = TEAM_AFFILIATION_TEAMS.map((team) => {
    const hit = byTeam.get(team);
    if (hit) return { ...hit, team };
    return emptyRows().find((row) => row.team === team)!;
  });
  return {
    date,
    effectiveFrom: meta?.effectiveFrom ?? null,
    source: meta?.source ?? "version",
    versionId: meta?.versionId ?? null,
    rows: merged,
  };
}

export function teamAffiliationRow(
  team: string,
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationRow {
  const key = String(team ?? "").trim();
  const src = snapshot ?? DEFAULT_TEAM_AFFILIATION_SNAPSHOT;
  const hit = src.rows.find((row) => row.team === key);
  if (hit) return hit;
  return {
    team: isTeamAffiliationTeam(key) ? key : "1조",
    affiliation: (DEFAULT_THIRD_TEAMS as readonly string[]).includes(key)
      ? "THIRD"
      : "HOUSE",
    operational: isTeamAffiliationTeam(key),
  };
}

export function resolveTeamAffiliation(
  team: string,
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationKind {
  return teamAffiliationRow(team, snapshot).affiliation;
}

export function isTeamOperational(
  team: string,
  snapshot?: TeamAffiliationSnapshot | null
): boolean {
  if (!isTeamAffiliationTeam(team)) return true;
  return teamAffiliationRow(team, snapshot).operational;
}

export function isHouseAffiliatedTeam(
  team: string,
  snapshot?: TeamAffiliationSnapshot | null
): boolean {
  return (
    isTeamAffiliationTeam(team) &&
    resolveTeamAffiliation(team, snapshot) === "HOUSE" &&
    isTeamOperational(team, snapshot)
  );
}

export function isThirdAffiliatedTeam(
  team: string,
  snapshot?: TeamAffiliationSnapshot | null
): boolean {
  return (
    isTeamAffiliationTeam(team) &&
    resolveTeamAffiliation(team, snapshot) === "THIRD" &&
    isTeamOperational(team, snapshot)
  );
}

export function houseTeamsInSnapshot(
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationTeam[] {
  return TEAM_AFFILIATION_TEAMS.filter((team) =>
    isHouseAffiliatedTeam(team, snapshot)
  );
}

export function thirdTeamsInSnapshot(
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationTeam[] {
  return TEAM_AFFILIATION_TEAMS.filter((team) =>
    isThirdAffiliatedTeam(team, snapshot)
  );
}

export function inactiveTeamsInSnapshot(
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationTeam[] {
  return TEAM_AFFILIATION_TEAMS.filter(
    (team) => !isTeamOperational(team, snapshot)
  );
}

/** 운영 여부 무시. 개별 캐디 조 선택용. 자동배치 후보는 house/thirdTeamsInSnapshot. */
export function teamsWithAffiliation(
  affiliation: TeamAffiliationKind,
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationTeam[] {
  return TEAM_AFFILIATION_TEAMS.filter(
    (team) => resolveTeamAffiliation(team, snapshot) === affiliation
  );
}

/** DRIVING은 Caddy.caddyType 이 권위. 그 외 1~12조는 스냅샷 소속. */
export function resolveAssignCaddyType(input: {
  team?: string | null;
  caddyType?: string | null;
  snapshot?: TeamAffiliationSnapshot | null;
}): "HOUSE" | "THIRD" | "DRIVING" {
  const stored = String(input.caddyType ?? "").trim().toUpperCase();
  if (stored === "DRIVING") return "DRIVING";
  const team = String(input.team ?? "").trim();
  if (team === "드라이빙") return "DRIVING";
  if (!isTeamAffiliationTeam(team)) {
    if (stored === "THIRD") return "THIRD";
    return "HOUSE";
  }
  return resolveTeamAffiliation(team, input.snapshot);
}

export function isInactiveTeamCaddy(input: {
  team?: string | null;
  caddyType?: string | null;
  snapshot?: TeamAffiliationSnapshot | null;
}): boolean {
  if (resolveAssignCaddyType(input) === "DRIVING") return false;
  return !isTeamOperational(String(input.team ?? ""), input.snapshot);
}

export function houseTenThirdOffSnapshot(
  date: string,
  effectiveFrom = date
): TeamAffiliationSnapshot {
  return snapshotFromRows(
    date,
    TEAM_AFFILIATION_TEAMS.map((team) => {
      const n = Number(team.replace("조", ""));
      return {
        team,
        affiliation: "HOUSE" as const,
        operational: n <= 10,
      };
    }),
    { effectiveFrom, source: "version", versionId: 1 }
  );
}

export function parseTeamAffiliationKind(value: unknown): TeamAffiliationKind {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "HOUSE") return "HOUSE";
  if (raw === "THIRD") return "THIRD";
  throw new TeamAffiliationError("소속은 HOUSE 또는 THIRD만 선택할 수 있습니다.");
}

export function parseOperationalFlag(value: unknown): boolean {
  if (value === true || value === "ACTIVE" || value === "운영") return true;
  if (value === false || value === "INACTIVE" || value === "미운영") {
    return false;
  }
  if (typeof value === "string") {
    const v = value.trim().toUpperCase();
    if (v === "TRUE" || v === "1" || v === "YES") return true;
    if (v === "FALSE" || v === "0" || v === "NO") return false;
  }
  throw new TeamAffiliationError("운영 상태는 운영/미운영만 선택할 수 있습니다.");
}

export function parseTeamAffiliationVersionInput(
  body: unknown
): TeamAffiliationVersionInput {
  const data = (body ?? {}) as Record<string, unknown>;
  const effectiveFrom = parseTeamAffiliationYmd(data.effectiveFrom);
  const note =
    data.note == null ? null : String(data.note).trim() || null;
  const teamsRaw = Array.isArray(data.teams) ? data.teams : null;
  if (!teamsRaw) {
    throw new TeamAffiliationError("teams 배열이 필요합니다.");
  }
  const seen = new Set<string>();
  const teams: TeamAffiliationVersionInput["teams"] = [];
  for (const raw of teamsRaw) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const team = String(row.team ?? "").trim();
    if (!isTeamAffiliationTeam(team)) {
      throw new TeamAffiliationError(`알 수 없는 조입니다: ${team || "(빈 값)"}`);
    }
    if (seen.has(team)) {
      throw new TeamAffiliationError(`${team} 설정이 중복입니다.`);
    }
    seen.add(team);
    const affiliation = parseTeamAffiliationKind(row.affiliation);
    const operational =
      row.operational === undefined && row.operationalStatus === undefined
        ? true
        : parseOperationalFlag(
            row.operational !== undefined
              ? row.operational
              : row.operationalStatus
          );
    teams.push({ team, affiliation, operational });
  }
  if (seen.size !== TEAM_AFFILIATION_TEAMS.length) {
    const missing = TEAM_AFFILIATION_TEAMS.filter((team) => !seen.has(team));
    throw new TeamAffiliationError(
      `12개 조 설정이 모두 필요합니다. 누락: ${missing.join(", ")}`
    );
  }
  return { effectiveFrom, note, teams };
}

export type RosterBandSpan = {
  band: "HOUSE" | "THIRD" | "INACTIVE" | "DRIVING";
  label: string;
  start: number;
  span: number;
  teams: string[];
};

export function rosterBandSpans(
  snapshot?: TeamAffiliationSnapshot | null
): RosterBandSpan[] {
  const spans: RosterBandSpan[] = [];
  const push = (
    band: RosterBandSpan["band"],
    label: string,
    start: number,
    teams: string[]
  ) => {
    if (teams.length === 0) return;
    spans.push({ band, label, start, span: teams.length, teams: [...teams] });
  };
  let currentBand: RosterBandSpan["band"] | null = null;
  let currentTeams: string[] = [];
  let start = 1;
  for (let i = 0; i < TEAM_AFFILIATION_TEAMS.length; i++) {
    const team = TEAM_AFFILIATION_TEAMS[i];
    const row = teamAffiliationRow(team, snapshot);
    const band: RosterBandSpan["band"] = !row.operational
      ? "INACTIVE"
      : row.affiliation;
    if (currentBand !== band) {
      if (currentBand) {
        push(
          currentBand,
          bandLabel(currentBand, currentTeams),
          start,
          currentTeams
        );
      }
      currentBand = band;
      currentTeams = [team];
      start = i + 1;
    } else {
      currentTeams.push(team);
    }
  }
  if (currentBand) {
    push(currentBand, bandLabel(currentBand, currentTeams), start, currentTeams);
  }
  spans.push({
    band: "DRIVING",
    label: "드라이빙",
    start: 13,
    span: 1,
    teams: ["드라이빙"],
  });
  return spans;
}

function bandLabel(band: RosterBandSpan["band"], teams: string[]): string {
  if (band === "INACTIVE") {
    return `미운영 ${teams[0]}${teams.length > 1 ? `~${teams[teams.length - 1]}` : ""}`;
  }
  if (band === "THIRD") {
    return `3부반 ${teams[0]}${teams.length > 1 ? `~${teams[teams.length - 1]}` : ""}`;
  }
  if (band === "HOUSE") {
    return `하우스 ${teams[0]}${teams.length > 1 ? `~${teams[teams.length - 1]}` : ""}`;
  }
  return "드라이빙";
}

export function pickLatestAffiliationVersion<T extends { effectiveFrom: string }>(
  versions: readonly T[],
  date: string
): T | null {
  const ymd = parseTeamAffiliationYmd(date);
  const eligible = versions
    .filter((row) => row.effectiveFrom <= ymd)
    .sort((a, b) => {
      if (a.effectiveFrom === b.effectiveFrom) return 0;
      return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    });
  return eligible[0] ?? null;
}
