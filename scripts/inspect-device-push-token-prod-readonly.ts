/**
 * Production READ ONLY: DevicePushToken pending / table / indexes / FK / counts.
 * WRITE 금지. migrate 금지. DevicePushToken DML 금지. FCM/Web Push send 금지.
 *
 * Before apply:
 *   npx tsx scripts/inspect-device-push-token-prod-readonly.ts
 *
 * After apply:
 *   EXPECT_DEVICE_PUSH_TOKEN_APPLIED=1 npx tsx scripts/inspect-device-push-token-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const MIGRATION_NAME = "20260921120000_device_push_token";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const ROOT = path.resolve(__dirname, "..");
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");

const EXPECTED_COLUMNS = [
  "id",
  "userId",
  "token",
  "platform",
  "enabled",
  "createdAt",
  "updatedAt",
  "lastFailureAt",
] as const;

const COUNT_TABLES = [
  "User",
  "PushSubscription",
  "Caddy",
  "Notice",
  "CourseReport",
  "CourseReportPhoto",
  "CommentThread",
  "Comment",
  "DailyBoardPublished",
  "Audit",
] as const;

function assertReadOnly() {
  if (
    process.env.MIGRATE === "1" ||
    process.env.DB_PUSH === "1" ||
    process.env.ALLOW_DB_WRITE === "1" ||
    process.env.PROD_MAINTENANCE_CONFIRM
  ) {
    throw new Error("write/migrate flags are not allowed for this inspect script");
  }
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function auditMigrationSql(sql: string): { ok: true } {
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
  ];
  for (const re of forbidden) {
    if (re.test(upper)) {
      throw new Error(`HOLD: migration.sql contains forbidden token ${re}`);
    }
  }
  if (/\bDELETE\b/.test(upper.replace(/ON\s+DELETE\s+CASCADE/g, ""))) {
    throw new Error("HOLD: migration.sql contains DELETE besides ON DELETE CASCADE");
  }
  if (/\bUPDATE\b/.test(upper.replace(/ON\s+UPDATE\s+CASCADE/g, ""))) {
    throw new Error("HOLD: migration.sql contains UPDATE besides ON UPDATE CASCADE");
  }
  if (/\bPUSHSUBSCRIPTION\b/.test(upper)) {
    throw new Error("HOLD: migration.sql must not change PushSubscription");
  }

  const typeRe = /\bCREATE\s+TYPE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const types: string[] = [];
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRe.exec(body))) types.push(typeMatch[1]);
  if (types.length !== 1 || types[0] !== "DevicePushPlatform") {
    throw new Error(`HOLD: expected CREATE TYPE DevicePushPlatform only, got ${types.join(",")}`);
  }

  const createRe = /\bCREATE\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const created: string[] = [];
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createRe.exec(body))) created.push(createMatch[1]);
  if (created.length !== 1 || created[0] !== "DevicePushToken") {
    throw new Error(`HOLD: expected CREATE TABLE DevicePushToken only, got ${created.join(",")}`);
  }

  const alterRe = /\bALTER\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let alters = 0;
  let alterMatch: RegExpExecArray | null;
  while ((alterMatch = alterRe.exec(body))) {
    alters += 1;
    if (alterMatch[1] !== "DevicePushToken") {
      throw new Error(`HOLD: ALTER TABLE on unexpected table ${alterMatch[1]}`);
    }
    const rest = body.slice(alterMatch.index, alterMatch.index + 500).toUpperCase();
    if (!/\bADD\s+CONSTRAINT\b/.test(rest)) {
      throw new Error("HOLD: DevicePushToken ALTER is not ADD CONSTRAINT");
    }
    if (/\bDROP\b/.test(rest) || /\bALTER\s+COLUMN\b/.test(rest) || /\bADD\s+COLUMN\b/.test(rest)) {
      throw new Error("HOLD: destructive/extra ALTER on DevicePushToken");
    }
  }
  if (alters !== 1) {
    throw new Error(`HOLD: expected 1 ALTER TABLE ADD CONSTRAINT, got ${alters}`);
  }
  if (!body.includes('CREATE UNIQUE INDEX "DevicePushToken_userId_token_key"')) {
    throw new Error("HOLD: missing unique(userId, token)");
  }
  if (!body.includes('CREATE INDEX "DevicePushToken_token_idx"')) {
    throw new Error("HOLD: missing token index");
  }
  if (!/FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE/.test(body)) {
    throw new Error("HOLD: User FK is not ON DELETE CASCADE");
  }
  return { ok: true };
}

function localMigrationNames(): string[] {
  const dir = path.join(ROOT, "prisma", "migrations");
  return fs
    .readdirSync(dir)
    .filter((name) => /^[0-9]{14}_/.test(name) && fs.existsSync(path.join(dir, name, "migration.sql")))
    .sort();
}

async function tableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '${table}'
     ) AS exists`
  );
  return Boolean(rows[0]?.exists);
}

async function countIfExists(prisma: PrismaClient, table: string): Promise<number | null> {
  if (!(await tableExists(prisma, table))) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "${table}"`
  );
  return Number(rows[0]?.n ?? 0);
}

async function describeTable(prisma: PrismaClient, table: string) {
  const columns = await prisma.$queryRawUnsafe<
    Array<{ column_name: string; udt_name: string; is_nullable: string }>
  >(
    `SELECT column_name, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}'
     ORDER BY ordinal_position`
  );
  const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = '${table}'
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
       AND tc.table_name = '${table}'
       AND tc.constraint_type = 'FOREIGN KEY'`
  );
  return { columns, indexes, fks };
}

async function main() {
  assertReadOnly();
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("PRODUCTION_DATABASE_URL required (read-only)");
  if (!isProductionDatabaseUrl(url)) {
    throw new Error("PRODUCTION_DATABASE_URL does not look like production");
  }
  const host = parseDatabaseUrl(url).hostname;
  if (host !== EXPECTED_HOST) {
    throw new Error(`unexpected host ${host}`);
  }

  const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");
  auditMigrationSql(sql);

  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    await prisma.$queryRaw`SELECT 1`;
    const appliedRows = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       ORDER BY finished_at ASC NULLS LAST, migration_name ASC`
    );
    const thisMig = appliedRows.filter((r) => r.migration_name === MIGRATION_NAME);
    const unfinished = appliedRows.filter((r) => !r.finished_at).map((r) => r.migration_name);
    const appliedFinished = new Set(
      appliedRows.filter((r) => r.finished_at).map((r) => r.migration_name)
    );
    const pendingFromFiles = localMigrationNames().filter((name) => !appliedFinished.has(name));

    const tokenExists = await tableExists(prisma, "DevicePushToken");
    const enumValues = (
      await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON t.oid = e.enumtypid
         WHERE t.typname = 'DevicePushPlatform'
         ORDER BY e.enumsortorder`
      )
    ).map((e) => e.enumlabel);

    const tokenDesc = tokenExists ? await describeTable(prisma, "DevicePushToken") : null;
    const pushDesc = await describeTable(prisma, "PushSubscription");

    const counts: Record<string, number | null> = {};
    for (const name of COUNT_TABLES) {
      counts[name] = await countIfExists(prisma, name);
    }
    counts.DevicePushToken = tokenExists ? await countIfExists(prisma, "DevicePushToken") : null;

    const colNames = tokenDesc?.columns.map((c) => c.column_name) ?? [];
    const idx = tokenDesc?.indexes ?? [];
    const uniquePresent = idx.some(
      (i) => i.indexname === "DevicePushToken_userId_token_key" && /UNIQUE/i.test(i.indexdef)
    );
    const tokenIndexPresent = idx.some((i) => i.indexname === "DevicePushToken_token_idx");
    const userFk = tokenDesc?.fks.find((f) => f.constraint_name === "DevicePushToken_userId_fkey");
    const migrationApplied = thisMig.length > 0 && Boolean(thisMig[0]?.finished_at);

    const okNotApplied =
      !migrationApplied &&
      !tokenExists &&
      enumValues.length === 0 &&
      pendingFromFiles.length === 1 &&
      pendingFromFiles[0] === MIGRATION_NAME &&
      unfinished.length === 0;
    const okApplied =
      migrationApplied &&
      tokenExists &&
      pendingFromFiles.length === 0 &&
      unfinished.length === 0 &&
      enumValues.join(",") === "ANDROID" &&
      EXPECTED_COLUMNS.every((c) => colNames.includes(c)) &&
      colNames.length === EXPECTED_COLUMNS.length &&
      uniquePresent &&
      tokenIndexPresent &&
      userFk?.foreign_table === "User" &&
      userFk?.foreign_column === "id" &&
      userFk?.delete_rule === "CASCADE" &&
      counts.DevicePushToken === 0;

    const expectApplied = process.env.EXPECT_DEVICE_PUSH_TOKEN_APPLIED === "1";
    const ok = expectApplied ? okApplied : okNotApplied;

    console.log(
      JSON.stringify(
        {
          ok,
          mode: "read-only",
          writes: false,
          expectApplied,
          okNotApplied,
          okApplied,
          host,
          sqlAudit: "PASS",
          sqlAdditiveOnly: true,
          pushSubscriptionDdlInMigration: false,
          migrationName: MIGRATION_NAME,
          migrationApplied,
          pendingFromFiles,
          unfinishedMigrations: unfinished,
          devicePushTokenTableExists: tokenExists,
          devicePushPlatform: enumValues.length ? enumValues : "missing",
          devicePushTokenColumns: colNames,
          devicePushTokenIndexes: idx.map((i) => ({
            name: i.indexname,
            unique: /UNIQUE/i.test(i.indexdef),
          })),
          uniqueUserIdToken: uniquePresent,
          tokenIndex: tokenIndexPresent,
          foreignKeys: tokenDesc?.fks ?? [],
          userFkOnDeleteCascade: userFk?.delete_rule === "CASCADE",
          devicePushTokenRows: counts.DevicePushToken,
          pushSubscription: {
            columns: pushDesc.columns.map((c) => ({
              name: c.column_name,
              type: c.udt_name,
              nullable: c.is_nullable,
            })),
            indexes: pushDesc.indexes.map((i) => ({
              name: i.indexname,
              unique: /UNIQUE/i.test(i.indexdef),
            })),
            fks: pushDesc.fks,
            rows: counts.PushSubscription,
          },
          majorTableCounts: counts,
        },
        null,
        2
      )
    );
    if (!ok) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
