/**
 * 조별 HOUSE/THIRD·운영 설정 로더.
 * 테이블이 없으면 기본 스냅샷(1~8 HOUSE, 9~12 THIRD)으로 폴백한다.
 * Caddy row / 확정 배치표 / 운영 명단은 읽기만 하고 변경하지 않는다.
 */

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  TEAM_AFFILIATION_TEAMS,
  TeamAffiliationError,
  cloneTeamAffiliationSnapshot,
  defaultTeamAffiliationSnapshot,
  parseTeamAffiliationVersionInput,
  parseTeamAffiliationYmd,
  snapshotFromRows,
  teamAffiliationUtcDate,
  teamAffiliationYmdFromDate,
  type TeamAffiliationKind,
  type TeamAffiliationRow,
  type TeamAffiliationSnapshot,
  type TeamAffiliationVersionInput,
} from "@/lib/teamAffiliation";

function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code)
      : "";
  return (
    code === "P2021" ||
    /TeamAffiliationVersion/i.test(msg) ||
    /TeamAffiliationItem/i.test(msg) ||
    /does not exist/i.test(msg)
  );
}

function ymdFromDate(value: Date | string): string {
  return teamAffiliationYmdFromDate(value);
}

function rowsFromItems(
  items: Array<{
    team: string;
    affiliation: string;
    operational: boolean;
  }>
): TeamAffiliationRow[] {
  const byTeam = new Map(
    items.map((item) => [
      item.team,
      {
        team: item.team as TeamAffiliationRow["team"],
        affiliation:
          String(item.affiliation).toUpperCase() === "THIRD"
            ? ("THIRD" as const)
            : ("HOUSE" as const),
        operational: item.operational !== false,
      },
    ])
  );
  return TEAM_AFFILIATION_TEAMS.map((team) => {
    const hit = byTeam.get(team);
    if (hit && TEAM_AFFILIATION_TEAMS.includes(hit.team)) return hit;
    return DEFAULT_TEAM_AFFILIATION_SNAPSHOT.rows.find((row) => row.team === team)!;
  });
}

export async function loadTeamAffiliationSnapshot(
  ymd: string
): Promise<TeamAffiliationSnapshot> {
  const date = parseTeamAffiliationYmd(ymd);
  try {
    const version = await prisma.teamAffiliationVersion.findFirst({
      where: { effectiveFrom: { lte: teamAffiliationUtcDate(date) } },
      orderBy: { effectiveFrom: "desc" },
      include: { items: { orderBy: { team: "asc" } } },
    });
    if (!version) return defaultTeamAffiliationSnapshot(date);
    return snapshotFromRows(date, rowsFromItems(version.items), {
      effectiveFrom: ymdFromDate(version.effectiveFrom),
      source: "version",
      versionId: version.id,
    });
  } catch (e) {
    if (isMissingTableError(e)) return defaultTeamAffiliationSnapshot(date);
    throw e;
  }
}

export async function listTeamAffiliationVersions(): Promise<
  Array<{
    id: number;
    effectiveFrom: string;
    note: string | null;
    createdAt: string;
    createdByUserId: number | null;
    rows: TeamAffiliationRow[];
  }>
> {
  try {
    const versions = await prisma.teamAffiliationVersion.findMany({
      orderBy: { effectiveFrom: "desc" },
      include: { items: { orderBy: { team: "asc" } } },
    });
    return versions.map((version) => ({
      id: version.id,
      effectiveFrom: ymdFromDate(version.effectiveFrom),
      note: version.note,
      createdAt: version.createdAt.toISOString(),
      createdByUserId: version.createdByUserId,
      rows: rowsFromItems(version.items),
    }));
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

export async function saveTeamAffiliationVersion(input: {
  body: unknown;
  userId?: number | null;
}): Promise<{
  snapshot: TeamAffiliationSnapshot;
  versionId: number;
}> {
  const parsed: TeamAffiliationVersionInput = parseTeamAffiliationVersionInput(
    input.body
  );
  const effectiveFrom = teamAffiliationUtcDate(parsed.effectiveFrom);
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.teamAffiliationVersion.findUnique({
        where: { effectiveFrom },
        select: { id: true },
      });
      const version = existing
        ? await tx.teamAffiliationVersion.update({
            where: { id: existing.id },
            data: {
              note: parsed.note,
              createdByUserId: input.userId ?? null,
              items: {
                deleteMany: {},
                create: parsed.teams.map((team) => ({
                  team: team.team,
                  affiliation: team.affiliation as TeamAffiliationKind,
                  operational: team.operational,
                })),
              },
            },
            include: { items: true },
          })
        : await tx.teamAffiliationVersion.create({
            data: {
              effectiveFrom,
              note: parsed.note,
              createdByUserId: input.userId ?? null,
              items: {
                create: parsed.teams.map((team) => ({
                  team: team.team,
                  affiliation: team.affiliation as TeamAffiliationKind,
                  operational: team.operational,
                })),
              },
            },
            include: { items: true },
          });
      await tx.audit.create({
        data: {
          action: existing
            ? "TEAM_AFFILIATION_VERSION_UPDATE"
            : "TEAM_AFFILIATION_VERSION_CREATE",
          entity: "TeamAffiliationVersion",
          entityId: version.id,
          payload: {
            effectiveFrom: parsed.effectiveFrom,
            note: parsed.note,
            teams: parsed.teams,
            caddyRowsUnchanged: true,
            publishedBoardsUnchanged: true,
          },
        },
      });
      return version;
    });
    return {
      versionId: saved.id,
      snapshot: snapshotFromRows(
        parsed.effectiveFrom,
        rowsFromItems(saved.items),
        {
          effectiveFrom: parsed.effectiveFrom,
          source: "version",
          versionId: saved.id,
        }
      ),
    };
  } catch (e) {
    if (isMissingTableError(e)) {
      throw new TeamAffiliationError(
        "조 설정 테이블이 아직 없습니다. local migration 적용 후 사용하세요.",
        "team_affiliation_unavailable",
        503
      );
    }
    throw e;
  }
}

export function snapshotOrDefault(
  snapshot?: TeamAffiliationSnapshot | null
): TeamAffiliationSnapshot {
  return snapshot
    ? cloneTeamAffiliationSnapshot(snapshot)
    : cloneTeamAffiliationSnapshot(DEFAULT_TEAM_AFFILIATION_SNAPSHOT);
}
