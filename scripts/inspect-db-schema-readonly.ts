/**
 * 운영 DB 읽기 전용 점검 스크립트
 *
 * 금지: migrate / db push / DROP / DELETE / UPDATE / INSERT
 * 허용: SELECT only
 *
 * 사용:
 *   DATABASE_URL=... npx tsx scripts/inspect-db-schema-readonly.ts
 *
 * 출력:
 *   - db-inspect/_prisma_migrations.json
 *   - db-inspect/caddy-columns.json
 *   - db-inspect/schema-diff-report.json
 *   - existing-caddies.json  (id,name,team only)
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const OUT_DIR = path.resolve("db-inspect");

function assertNoWriteFlags() {
  const banned = ["MIGRATE", "DB_PUSH", "ALLOW_DB_WRITE"];
  for (const k of banned) {
    if (process.env[k] === "1") {
      throw new Error(`${k}=1 is not allowed for this script`);
    }
  }
}

async function main() {
  assertNoWriteFlags();

  if (!process.env.DATABASE_URL) {
    console.error(`
DATABASE_URL 이 없습니다.

다음 중 하나로 제공하세요 (채팅에 URL을 붙이지 말 것):
1) Cursor Agent Secrets 에 DATABASE_URL 등록
2) 로컬/CI에서 DATABASE_URL=... 로 이 스크립트 실행
3) 대신 existing-caddies.json 만 직접 제공

이 스크립트는 SELECT만 수행합니다.
`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prisma = new PrismaClient();

  try {
    // 1) applied migrations
    const migrations = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        checksum: string;
        finished_at: Date | null;
        migration_name: string;
        applied_steps_count: number;
      }>
    >(
      `SELECT id, checksum, finished_at, migration_name, applied_steps_count
       FROM "_prisma_migrations"
       ORDER BY finished_at ASC NULLS LAST, migration_name ASC`
    );
    fs.writeFileSync(
      path.join(OUT_DIR, "_prisma_migrations.json"),
      JSON.stringify(migrations, null, 2)
    );

    // 2) Caddy columns
    const caddyColumns = await prisma.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Caddy'
       ORDER BY ordinal_position`
    );
    fs.writeFileSync(
      path.join(OUT_DIR, "caddy-columns.json"),
      JSON.stringify(caddyColumns, null, 2)
    );

    // 3) public tables
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    // 4) expected from current Prisma schema (static list from repo knowledge)
    const expectedCaddyColumns = [
      "id",
      "name",
      "team",
      "status",
      "memo",
      "createdAt",
      "updatedAt",
    ];
    const expectedTables = [
      "Caddy",
      "Assignment",
      "Audit",
      "DailySchedule",
      "Schedule",
      "Notice",
      "User",
      "ShiftDuty",
      "ScheduleExtraTag",
      "_prisma_migrations",
    ];

    const actualCaddy = new Set(caddyColumns.map((c) => c.column_name));
    const actualTables = new Set(tables.map((t) => t.table_name));

    const report = {
      mode: "read-only",
      writes: false,
      migrationsCount: migrations.length,
      migrationNames: migrations.map((m) => m.migration_name),
      caddyColumns: caddyColumns.map((c) => c.column_name),
      missingCaddyColumnsVsSchema: expectedCaddyColumns.filter((c) => !actualCaddy.has(c)),
      extraCaddyColumnsVsSchema: [...actualCaddy].filter(
        (c) => !expectedCaddyColumns.includes(c)
      ),
      missingTablesVsSchema: expectedTables.filter((t) => !actualTables.has(t)),
      extraTablesVsSchema: [...actualTables].filter((t) => !expectedTables.includes(t)),
      statusColumnPresent: actualCaddy.has("status"),
    };
    fs.writeFileSync(
      path.join(OUT_DIR, "schema-diff-report.json"),
      JSON.stringify(report, null, 2)
    );

    // 5) existing caddies snapshot (id,name,team only) via raw SQL to avoid missing-column Prisma model errors
    const caddies = await prisma.$queryRawUnsafe<
      Array<{ id: number; name: string; team: string }>
    >(
      `SELECT id, name, team
       FROM "Caddy"
       ORDER BY id ASC`
    );
    const snapshotPath = path.resolve("existing-caddies.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(caddies, null, 2));

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "read-only",
          migrationsCount: report.migrationsCount,
          caddyCount: caddies.length,
          statusColumnPresent: report.statusColumnPresent,
          missingCaddyColumnsVsSchema: report.missingCaddyColumnsVsSchema,
          missingTablesVsSchema: report.missingTablesVsSchema,
          outDir: OUT_DIR,
          snapshotPath,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
