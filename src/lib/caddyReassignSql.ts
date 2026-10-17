/**
 * 캐디 일괄 재배치 — 서버 전용 Prisma SQL.
 * 순수 계획(caddyReassign.ts)과 분리해 클라이언트 번들에 넣지 않는다.
 */
import { Prisma } from "@prisma/client";
import { isPrimaryTeam } from "@/lib/caddyManage";
import type { ReassignPatch } from "@/lib/caddyReassign";

/**
 * Caddy 조/순번/타입/3부반만 갱신. id 및 그 외 컬럼은 SQL에 등장하지 않는다.
 */
export function buildCaddyReassignUpdateSql(patches: ReassignPatch[]): Prisma.Sql {
  if (patches.length === 0) {
    throw new Error("reassign update requires at least one row");
  }
  const values = patches.map(
    (patch) => Prisma.sql`(
      ${patch.id}::integer,
      ${patch.team}::text,
      ${patch.teamOrder}::integer,
      ${patch.caddyType}::text,
      ${patch.thirdBandSubgroup}::text
    )`
  );
  return Prisma.sql`
    UPDATE "Caddy" AS c
    SET
      "team" = v."team",
      "teamOrder" = v."teamOrder",
      "caddyType" = v."caddyType"::"CaddyType",
      "thirdBandSubgroup" = v."thirdBandSubgroup"::"ThirdBandSubgroup",
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      VALUES ${Prisma.join(values, ",")}
    ) AS v(
      "id",
      "team",
      "teamOrder",
      "caddyType",
      "thirdBandSubgroup"
    )
    WHERE c."id" = v."id"
  `;
}

export function buildCaddyReassignLockSql(
  teams: string[],
  ids: number[]
): Prisma.Sql {
  const teamList = teams
    .filter((team) => isPrimaryTeam(team))
    .sort((a, b) => Number(a.replace("조", "")) - Number(b.replace("조", "")));
  const idList = ids
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (teamList.length === 0 && idList.length === 0) {
    throw new Error("reassign lock requires teams or ids");
  }
  if (teamList.length > 0 && idList.length > 0) {
    return Prisma.sql`
      SELECT
        id,
        name,
        team,
        "teamOrder",
        "employmentStatus"::text AS "employmentStatus",
        "caddyType"::text AS "caddyType",
        "thirdBandSubgroup"::text AS "thirdBandSubgroup",
        "updatedAt"
      FROM "Caddy"
      WHERE team IN (${Prisma.join(teamList)})
         OR id IN (${Prisma.join(idList)})
      FOR UPDATE
    `;
  }
  if (teamList.length > 0) {
    return Prisma.sql`
      SELECT
        id,
        name,
        team,
        "teamOrder",
        "employmentStatus"::text AS "employmentStatus",
        "caddyType"::text AS "caddyType",
        "thirdBandSubgroup"::text AS "thirdBandSubgroup",
        "updatedAt"
      FROM "Caddy"
      WHERE team IN (${Prisma.join(teamList)})
      FOR UPDATE
    `;
  }
  return Prisma.sql`
    SELECT
      id,
      name,
      team,
      "teamOrder",
      "employmentStatus"::text AS "employmentStatus",
      "caddyType"::text AS "caddyType",
      "thirdBandSubgroup"::text AS "thirdBandSubgroup",
      "updatedAt"
    FROM "Caddy"
    WHERE id IN (${Prisma.join(idList)})
    FOR UPDATE
  `;
}
