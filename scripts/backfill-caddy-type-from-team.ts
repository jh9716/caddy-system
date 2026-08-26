/**
 * 9~12조 caddyType 정리: HOUSE → THIRD
 *
 * 기본: read-only dry-run (SELECT only). thirdBandSubgroup 미변경.
 * Write는 명시적 승인 환경변수가 둘 다 있을 때만:
 *   ALLOW_CADDY_TYPE_BACKFILL=1
 *   CONFIRM_CADDY_TYPE_BACKFILL=THIRD_TEAMS_9_12
 *
 *   DATABASE_URL=... npx tsx scripts/backfill-caddy-type-from-team.ts
 *   DATABASE_URL=... ALLOW_CADDY_TYPE_BACKFILL=1 CONFIRM_CADDY_TYPE_BACKFILL=THIRD_TEAMS_9_12 \
 *     npx tsx scripts/backfill-caddy-type-from-team.ts
 *
 * Production write는 별도 승인 전까지 실행하지 마세요.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { THIRD_BAND_TEAMS } from "../src/lib/caddyManage";
import { isProductionDatabaseUrl } from "./assertLocalDatabaseUrl";
import { requireProdMaintenance } from "./requireProdMaintenance";

const WRITE_CONFIRM = "THIRD_TEAMS_9_12";
const TEAMS = [...THIRD_BAND_TEAMS];

function wantsWrite(): boolean {
  return (
    process.env.ALLOW_CADDY_TYPE_BACKFILL === "1" &&
    process.env.CONFIRM_CADDY_TYPE_BACKFILL === WRITE_CONFIRM
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 필요합니다.");
    process.exit(2);
  }

  const write = wantsWrite();
  if (write) {
    if (isProductionDatabaseUrl(process.env.DATABASE_URL)) {
      requireProdMaintenance("CADDY_TYPE_BACKFILL");
    }
    console.error(
      "WRITE MODE: 9~12조 HOUSE → THIRD 만 갱신합니다. thirdBandSubgroup 보존."
    );
  } else {
    console.log("DRY-RUN (read-only). Write하려면 ALLOW_CADDY_TYPE_BACKFILL=1 와");
    console.log(`CONFIRM_CADDY_TYPE_BACKFILL=${WRITE_CONFIRM} 가 모두 필요합니다.`);
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.caddy.findMany({
      where: {
        team: { in: TEAMS },
        caddyType: "HOUSE",
      },
      select: {
        id: true,
        team: true,
        caddyType: true,
        employmentStatus: true,
        thirdBandSubgroup: true,
      },
      orderBy: [{ team: "asc" }, { id: "asc" }],
    });

    const byTeam: Record<string, number> = {};
    const byEmp: Record<string, number> = {};
    for (const r of rows) {
      byTeam[r.team] = (byTeam[r.team] ?? 0) + 1;
      byEmp[r.employmentStatus] = (byEmp[r.employmentStatus] ?? 0) + 1;
    }

    const report = {
      mode: write ? "write" : "dry-run",
      targetTeams: TEAMS,
      count: rows.length,
      byTeam,
      byEmploymentStatus: byEmp,
      thirdBandSubgroupUntouched: true,
    };
    console.log(JSON.stringify(report, null, 2));

    if (!write) {
      console.log("read-only: no DB writes performed");
      return;
    }

    const result = await prisma.caddy.updateMany({
      where: {
        team: { in: TEAMS },
        caddyType: "HOUSE",
      },
      data: { caddyType: "THIRD" },
    });
    console.log(JSON.stringify({ updated: result.count }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
