/**
 * Production: apply additive CourseReportPhoto V1 migration only.
 *
 *   PROD_MAINTENANCE_CONFIRM=COURSE_REPORT_PHOTO_V1_20260919 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-course-report-photo-v1-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 * Forbidden: Vercel Blob store create / token mint / image upload
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "COURSE_REPORT_PHOTO_V1_20260919";
const MIGRATION_NAME = "20260918233000_course_report_photo_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

const EXPECTED_COLUMNS = [
  "id",
  "reportId",
  "storageKey",
  "mimeType",
  "size",
  "sortOrder",
  "createdAt",
] as const;

const EXPECTED_INDEXES = [
  "CourseReportPhoto_pkey",
  "CourseReportPhoto_storageKey_key",
  "CourseReportPhoto_reportId_sortOrder_idx",
] as const;

const COUNT_TABLES = [
  "User",
  "Caddy",
  "Notice",
  "DailyBoardPublished",
  "PushSubscription",
  "CourseReport",
] as const;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function auditMigrationSql(sql: string): void {
  const body = stripSqlComments(sql);
  const upper = body.toUpperCase();

  const forbidden = [
    /\bDROP\b/,
    /\bTRUNCATE\b/,
    /\bINSERT\b/,
    /\bREWRITE\b/,
    /\bSET\s+DATA\s+TYPE\b/,
    /\bMIGRATE\s+RESET\b/,
    /\bMIGRATE\s+DEV\b/,
    /\bDELETE\s+FROM\b/,
    /\bUPDATE\s+"?[A-Z0-9_]+"?\s+SET\b/,
    /\bDB\s+PUSH\b/,
    /\bSEED\b/,
    /\bBYTEA\b/,
    /\bPUBLICURL\b/,
  ];
  for (const re of forbidden) {
    if (re.test(upper)) {
      throw new Error(`HOLD: migration.sql contains forbidden token ${re}`);
    }
  }
  const deleteStripped = upper.replace(
    /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL)/g,
    ""
  );
  if (/\bDELETE\b/.test(deleteStripped)) {
    throw new Error("HOLD: migration.sql contains DELETE besides ON DELETE rules");
  }
  const updateStripped = upper.replace(/ON\s+UPDATE\s+CASCADE/g, "");
  if (/\bUPDATE\b/.test(updateStripped)) {
    throw new Error("HOLD: migration.sql contains UPDATE besides ON UPDATE CASCADE");
  }
  if (/\bCREATE\s+TYPE\b/i.test(body)) {
    throw new Error("HOLD: unexpected CREATE TYPE");
  }

  const createRe = /\bCREATE\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const created: string[] = [];
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createRe.exec(body))) created.push(createMatch[1]);
  if (created.length !== 1 || created[0] !== "CourseReportPhoto") {
    throw new Error(`HOLD: expected CREATE TABLE CourseReportPhoto only, got ${created.join(",")}`);
  }

  if (!/CREATE\s+UNIQUE\s+INDEX\s+"CourseReportPhoto_storageKey_key"/i.test(body)) {
    throw new Error("HOLD: missing unique storageKey index");
  }
  if (!/CREATE\s+INDEX\s+"CourseReportPhoto_reportId_sortOrder_idx"/i.test(body)) {
    throw new Error("HOLD: missing reportId/sortOrder index");
  }

  const alterRe = /\bALTER\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let alters = 0;
  let alterMatch: RegExpExecArray | null;
  while ((alterMatch = alterRe.exec(body))) {
    alters += 1;
    if (alterMatch[1] !== "CourseReportPhoto") {
      throw new Error(`HOLD: ALTER TABLE on existing table ${alterMatch[1]}`);
    }
    const rest = body.slice(alterMatch.index, alterMatch.index + 500).toUpperCase();
    if (!/\bADD\s+CONSTRAINT\b/.test(rest)) {
      throw new Error("HOLD: CourseReportPhoto ALTER is not ADD CONSTRAINT");
    }
    if (/\bDROP\b/.test(rest) || /\bALTER\s+COLUMN\b/.test(rest) || /\bADD\s+COLUMN\b/.test(rest)) {
      throw new Error("HOLD: destructive/extra ALTER on CourseReportPhoto");
    }
  }
  if (alters !== 1) {
    throw new Error(`HOLD: expected 1 ALTER TABLE ADD CONSTRAINT, got ${alters}`);
  }
  if (!/ON DELETE CASCADE ON UPDATE CASCADE/.test(body)) {
    throw new Error("HOLD: reportId FK is not ON DELETE CASCADE");
  }
  for (const col of EXPECTED_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing column ${col} in SQL`);
    }
  }
  if (/\bWIDTH\b/.test(upper) || /\bHEIGHT\b/.test(upper)) {
    throw new Error("HOLD: width/height columns are not in V1");
  }
}

function runPrisma(args: string[]): string {
  if (args[0] !== "migrate" || (args[1] !== "status" && args[1] !== "deploy")) {
    throw new Error(`HOLD: refusing prisma ${args.join(" ")}`);
  }
  if (args[1] === "deploy" && args.length !== 2) {
    throw new Error("HOLD: prisma migrate deploy must have no extra flags");
  }
  const r = spawnSync("npx", ["prisma", ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0 && args[1] === "deploy") {
    throw new Error(`prisma migrate deploy failed (exit ${r.status})`);
  }
  return `${r.stdout || ""}\n${r.stderr || ""}`;
}

function parsePending(statusOut: string): string[] {
  const pending: string[] = [];
  const lines = statusOut.split(/\r?\n/);
  let inPending = false;
  for (const line of lines) {
    if (/have not yet been applied/i.test(line)) {
      inPending = true;
      continue;
    }
    if (inPending) {
      const name = line.trim();
      if (!name) {
        inPending = false;
        continue;
      }
      if (/^To apply migrations/i.test(name) || /^Database schema is up to date/i.test(name)) {
        inPending = false;
        continue;
      }
      if (/^[0-9]{14}_/.test(name)) pending.push(name);
    }
  }
  if (/Database schema is up to date/i.test(statusOut)) return [];
  return pending;
}

async function countNamedTables(
  prisma: PrismaClient,
  tables: readonly string[]
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "${name}"`
    );
    out[name] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

async function describePhoto(prisma: PrismaClient) {
  const columns = await prisma.$queryRawUnsafe<
    Array<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>
  >(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'CourseReportPhoto'
     ORDER BY ordinal_position`
  );
  const indexes = await prisma.$queryRawUnsafe<
    Array<{ indexname: string; indexdef: string }>
  >(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'CourseReportPhoto'
     ORDER BY indexname`
  );
  const fks = await prisma.$queryRawUnsafe<
    Array<{
      constraint_name: string;
      column_name: string;
      foreign_table: string;
      foreign_column: string;
      delete_rule: string;
      update_rule: string;
    }>
  >(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS foreign_table,
       ccu.column_name AS foreign_column,
       rc.delete_rule,
       rc.update_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_name = rc.constraint_name
      AND tc.constraint_schema = rc.constraint_schema
     JOIN information_schema.constraint_column_usage ccu
       ON rc.unique_constraint_name = ccu.constraint_name
      AND rc.unique_constraint_schema = ccu.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'CourseReportPhoto'
       AND tc.constraint_type = 'FOREIGN KEY'`
  );
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null }>
  >(
    `SELECT migration_name, finished_at
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "CourseReportPhoto"`
  );
  return { columns, indexes, fks, applied, rowCount: Number(rows[0]?.n ?? -1) };
}

function assertSchema(desc: Awaited<ReturnType<typeof describePhoto>>): void {
  const colNames = desc.columns.map((c) => c.column_name);
  for (const col of EXPECTED_COLUMNS) {
    if (!colNames.includes(col)) throw new Error(`HOLD: missing column ${col}`);
  }
  if (colNames.length !== EXPECTED_COLUMNS.length) {
    throw new Error(`HOLD: unexpected columns: ${colNames.join(",")}`);
  }
  if (colNames.includes("publicUrl") || colNames.includes("bytes") || colNames.includes("width")) {
    throw new Error("HOLD: forbidden photo column present");
  }
  const idx = desc.indexes.map((i) => i.indexname);
  for (const name of EXPECTED_INDEXES) {
    if (!idx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  const fk = desc.fks.find((f) => f.constraint_name === "CourseReportPhoto_reportId_fkey");
  if (
    !fk ||
    fk.foreign_table !== "CourseReport" ||
    fk.column_name !== "reportId" ||
    fk.delete_rule !== "CASCADE"
  ) {
    throw new Error("HOLD: reportId FK is not CourseReport CASCADE");
  }
  if (desc.rowCount !== 0) {
    throw new Error(`HOLD: CourseReportPhoto row count ${desc.rowCount}, expected 0`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error("SQL audit: PASS (CREATE TABLE CourseReportPhoto + unique + index + FK CASCADE)");

  const { host } = requireProdMaintenance(TASK_ID);
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${host}`);
  }
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    if (!tableNames.includes("CourseReport")) {
      throw new Error("HOLD: CourseReport table missing; photo migration depends on it");
    }
    const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const appliedCount = Number(already[0]?.n ?? 0);
    const beforeCounts = await countNamedTables(prisma, COUNT_TABLES);

    if (appliedCount === 1) {
      if (!tableNames.includes("CourseReportPhoto")) {
        throw new Error("HOLD: migration recorded but CourseReportPhoto table missing");
      }
      const desc = await describePhoto(prisma);
      assertSchema(desc);
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "already-applied",
            host,
            migration: MIGRATION_NAME,
            counts: beforeCounts,
            courseReportPhotoRows: desc.rowCount,
            columns: desc.columns.map((c) => c.column_name),
            indexes: desc.indexes.map((i) => i.indexname),
            fks: desc.fks.map((f) => ({
              name: f.constraint_name,
              column: f.column_name,
              delete: f.delete_rule,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (tableNames.includes("CourseReportPhoto")) {
      throw new Error("HOLD: CourseReportPhoto exists but migration is not recorded");
    }

    console.log(
      JSON.stringify(
        {
          mode: "pre-deploy",
          host,
          pendingExpected: MIGRATION_NAME,
          counts: beforeCounts,
        },
        null,
        2
      )
    );

    const statusOut = runPrisma(["migrate", "status"]);
    const pending = parsePending(statusOut);
    if (pending.length !== 1 || pending[0] !== MIGRATION_NAME) {
      throw new Error(
        `HOLD: pending migrations ${JSON.stringify(pending)} — only ${MIGRATION_NAME} is allowed`
      );
    }

    console.error("=== prisma migrate deploy ===");
    runPrisma(["migrate", "deploy"]);

    const afterCounts = await countNamedTables(prisma, COUNT_TABLES);
    for (const name of COUNT_TABLES) {
      if (afterCounts[name] !== beforeCounts[name]) {
        throw new Error(
          `HOLD: ${name} count ${beforeCounts[name]} -> ${afterCounts[name]}`
        );
      }
    }
    const desc = await describePhoto(prisma);
    assertSchema(desc);

    const statusAfter = runPrisma(["migrate", "status"]);
    const pendingAfter = parsePending(statusAfter);
    if (pendingAfter.length !== 0 && !/Database schema is up to date/i.test(statusAfter)) {
      throw new Error(`HOLD: pending after deploy ${JSON.stringify(pendingAfter)}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "deployed",
          host,
          migration: MIGRATION_NAME,
          countsBefore: beforeCounts,
          countsAfter: afterCounts,
          countsUnchanged: true,
          courseReportPhotoRows: desc.rowCount,
          columns: desc.columns.map((c) => ({
            name: c.column_name,
            type: c.udt_name,
            nullable: c.is_nullable,
            default: c.column_default,
          })),
          indexes: desc.indexes.map((i) => i.indexname),
          fks: desc.fks.map((f) => ({
            name: f.constraint_name,
            column: f.column_name,
            references: `${f.foreign_table}.${f.foreign_column}`,
            delete: f.delete_rule,
            update: f.update_rule,
          })),
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
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
