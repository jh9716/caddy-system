import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [caddyCount, assignmentCount, scheduleCount, shiftDutyCount] = await Promise.all([
    prisma.caddy.count(),
    prisma.assignment.count(),
    prisma.schedule.count(),
    prisma.shiftDuty.count(),
  ]);

  const byType = await prisma.caddy.groupBy({
    by: ["caddyType"],
    _count: { _all: true },
    orderBy: { caddyType: "asc" },
  });

  const drivingCount = await prisma.caddy.count({ where: { caddyType: "DRIVING" } });

  const thirdByTeam = await prisma.caddy.groupBy({
    by: ["team"],
    where: { caddyType: "THIRD" },
    _count: { _all: true },
    orderBy: { team: "asc" },
  });

  const houseByTeam = await prisma.caddy.groupBy({
    by: ["team"],
    where: { caddyType: "HOUSE" },
    _count: { _all: true },
    orderBy: { team: "asc" },
  });

  type Row = { team: string; cnt: number };
  const houseIn912 = await prisma.$queryRaw<Row[]>`
    SELECT team, COUNT(*)::int AS cnt
    FROM "Caddy"
    WHERE "caddyType" = 'HOUSE'
      AND NULLIF(regexp_replace(team, '[^0-9]', '', 'g'), '')::INTEGER BETWEEN 9 AND 12
    GROUP BY team
    ORDER BY team
  `;

  const thirdOutside912 = await prisma.$queryRaw<Row[]>`
    SELECT team, COUNT(*)::int AS cnt
    FROM "Caddy"
    WHERE "caddyType" = 'THIRD'
      AND (
        NULLIF(regexp_replace(team, '[^0-9]', '', 'g'), '') IS NULL
        OR NULLIF(regexp_replace(team, '[^0-9]', '', 'g'), '')::INTEGER NOT BETWEEN 9 AND 12
      )
    GROUP BY team
    ORDER BY team
  `;

  type CountRow = { cnt: number };
  const orphanAssignments = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::int AS cnt
    FROM "Assignment" a
    LEFT JOIN "Caddy" c ON c.id = a."caddyId"
    WHERE c.id IS NULL
  `;

  const orphanSchedules = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::int AS cnt
    FROM "Schedule" s
    LEFT JOIN "Caddy" c ON c.id = s."caddyId"
    WHERE c.id IS NULL
  `;

  const assignmentLinked = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(DISTINCT a."caddyId")::int AS cnt
    FROM "Assignment" a
    INNER JOIN "Caddy" c ON c.id = a."caddyId"
  `;

  const scheduleLinked = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(DISTINCT s."caddyId")::int AS cnt
    FROM "Schedule" s
    INNER JOIN "Caddy" c ON c.id = s."caddyId"
  `;

  console.log("=== POST-MIGRATION VERIFICATION (read-only) ===");
  console.log(JSON.stringify(
    {
      counts: { caddyCount, assignmentCount, scheduleCount, shiftDutyCount },
      caddyTypeBreakdown: byType.map((r) => ({ type: r.caddyType, count: r._count._all })),
      drivingCount,
      houseByTeam: houseByTeam.map((r) => ({ team: r.team, count: r._count._all })),
      thirdByTeam: thirdByTeam.map((r) => ({ team: r.team, count: r._count._all })),
      anomalies: {
        houseInTeams9to12: houseIn912,
        thirdOutsideTeams9to12: thirdOutside912,
      },
      relationshipIntegrity: {
        orphanAssignments: orphanAssignments[0]?.cnt ?? 0,
        orphanSchedules: orphanSchedules[0]?.cnt ?? 0,
        distinctCaddiesWithAssignments: assignmentLinked[0]?.cnt ?? 0,
        distinctCaddiesWithSchedules: scheduleLinked[0]?.cnt ?? 0,
      },
      checks: {
        caddyCountIs183: caddyCount === 183,
        drivingIsZero: drivingCount === 0,
        noOrphanAssignments: (orphanAssignments[0]?.cnt ?? 0) === 0,
        noOrphanSchedules: (orphanSchedules[0]?.cnt ?? 0) === 0,
        noHouseIn912: houseIn912.length === 0,
        noThirdOutside912: thirdOutside912.length === 0,
      },
    },
    null,
    2
  ));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
