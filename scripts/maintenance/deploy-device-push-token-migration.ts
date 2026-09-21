/**
 * Production: apply additive DevicePushToken migration only.
 *
 *   PROD_MAINTENANCE_CONFIRM=PREPARE_DEVICE_PUSH_TOKEN_175_20260922 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-device-push-token-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 * Forbidden: DevicePushToken DML, FCM send, Web Push send, PushSubscription write
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "PREPARE_DEVICE_PUSH_TOKEN_175_20260922";
const MIGRATION_NAME = "20260921120000_device_push_token";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

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

const EXPECTED_INDEXES = [
  "DevicePushToken_pkey",
  "DevicePushToken_userId_token_key",
  "DevicePushToken_token_idx",
  "DevicePushToken_userId_idx",
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
  if (!/CREATE\s+TYPE\s+"DevicePushPlatform"\s+AS\s+ENUM\s*\(\s*'ANDROID'\s*\)/i.test(body)) {
    throw new Error("HOLD: DevicePushPlatform enum value must be ANDROID");
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
  if (!body.includes('CREATE INDEX "DevicePushToken_userId_idx"')) {
    throw new Error("HOLD: missing userId index");
  }
  if (
    !/FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/.test(
      body
    )
  ) {
    throw new Error("HOLD: User FK is not ON DELETE CASCADE");
  }
  for (const col of EXPECTED_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing DevicePushToken column ${col} in SQL`);
    }
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

async function describeTable(prisma: PrismaClient, table: string) {
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

function snapshotPush(desc: Awaited<ReturnType<typeof describeTable>>) {
  return {
    columns: desc.columns.map((c) => `${c.column_name}:${c.udt_name}:${c.is_nullable}`),
    indexes: desc.indexes.map((i) => `${i.indexname}|${i.indexdef}`),
    fks: desc.fks.map(
      (f) =>
        `${f.constraint_name}:${f.column_name}->${f.foreign_table}.${f.foreign_column}:${f.delete_rule}:${f.update_rule}`
    ),
  };
}

async function describeDevicePushToken(prisma: PrismaClient) {
  const enumValues = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
    `SELECT e.enumlabel
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'DevicePushPlatform'
     ORDER BY e.enumsortorder`
  );
  const table = await describeTable(prisma, "DevicePushToken");
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null; checksum: string }>
  >(
    `SELECT migration_name, finished_at, checksum
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "DevicePushToken"`
  );
  return {
    enumValues: enumValues.map((e) => e.enumlabel),
    ...table,
    applied,
    tokenRows: Number(rows[0]?.n ?? -1),
  };
}

function assertSchema(desc: Awaited<ReturnType<typeof describeDevicePushToken>>): void {
  if (desc.enumValues.join(",") !== "ANDROID") {
    throw new Error(`HOLD: DevicePushPlatform values ${desc.enumValues.join(",")}`);
  }
  const cols = desc.columns.map((c) => c.column_name);
  for (const col of EXPECTED_COLUMNS) {
    if (!cols.includes(col)) throw new Error(`HOLD: missing DevicePushToken column ${col}`);
  }
  if (cols.length !== EXPECTED_COLUMNS.length) {
    throw new Error(`HOLD: unexpected DevicePushToken columns: ${cols.join(",")}`);
  }
  const idx = desc.indexes.map((i) => i.indexname);
  for (const name of EXPECTED_INDEXES) {
    if (!idx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  const unique = desc.indexes.find((i) => i.indexname === "DevicePushToken_userId_token_key");
  if (!unique || !/UNIQUE/i.test(unique.indexdef)) {
    throw new Error("HOLD: unique(userId, token) missing");
  }
  if (!/userId/i.test(unique.indexdef) || !/token/i.test(unique.indexdef)) {
    throw new Error("HOLD: unique index does not cover (userId, token)");
  }
  const tokenIdx = desc.indexes.find((i) => i.indexname === "DevicePushToken_token_idx");
  if (!tokenIdx || !/token/i.test(tokenIdx.indexdef)) {
    throw new Error("HOLD: token index missing");
  }
  const fk = desc.fks.find((f) => f.constraint_name === "DevicePushToken_userId_fkey");
  if (!fk) throw new Error("HOLD: User FK missing");
  if (fk.column_name !== "userId" || fk.foreign_table !== "User" || fk.foreign_column !== "id") {
    throw new Error("HOLD: User FK target mismatch");
  }
  if (fk.delete_rule !== "CASCADE") {
    throw new Error(`HOLD: User FK ON DELETE is ${fk.delete_rule}, expected CASCADE`);
  }
  if (desc.tokenRows !== 0) {
    throw new Error(`HOLD: DevicePushToken row count ${desc.tokenRows}, expected 0`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
}

function schemaSummary(desc: Awaited<ReturnType<typeof describeDevicePushToken>>) {
  return {
    enum: desc.enumValues,
    columns: desc.columns.map((c) => ({
      name: c.column_name,
      type: c.udt_name,
      nullable: c.is_nullable,
    })),
    indexes: desc.indexes.map((i) => ({
      name: i.indexname,
      unique: /UNIQUE/i.test(i.indexdef),
    })),
    fks: desc.fks.map((f) => ({
      name: f.constraint_name,
      column: f.column_name,
      references: `${f.foreign_table}.${f.foreign_column}`,
      delete: f.delete_rule,
      update: f.update_rule,
    })),
    devicePushTokenRows: desc.tokenRows,
    migration: desc.applied[0]
      ? { name: desc.applied[0].migration_name, finished: Boolean(desc.applied[0].finished_at) }
      : null,
  };
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error("SQL audit: PASS (additive CREATE TYPE/TABLE DevicePushToken + indexes + User FK)");

  const { host } = requireProdMaintenance(TASK_ID);
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${host}`);
  }
  const prisma = new PrismaClient();
  try {
    if (!(await tableExists(prisma, "User"))) {
      throw new Error("HOLD: User table missing; DevicePushToken FK depends on it");
    }
    if (!(await tableExists(prisma, "PushSubscription"))) {
      throw new Error("HOLD: PushSubscription table missing; invariance check requires it");
    }

    const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const appliedCount = Number(already[0]?.n ?? 0);
    const beforeCounts = await countNamedTables(prisma, COUNT_TABLES);
    const tokenExists = await tableExists(prisma, "DevicePushToken");
    const pushBefore = snapshotPush(await describeTable(prisma, "PushSubscription"));

    if (appliedCount === 1) {
      if (!tokenExists) {
        throw new Error("HOLD: migration recorded but DevicePushToken table missing");
      }
      const desc = await describeDevicePushToken(prisma);
      assertSchema(desc);
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "already-applied",
            host,
            ...schemaSummary(desc),
            counts: beforeCounts,
          },
          null,
          2
        )
      );
      return;
    }

    if (tokenExists) {
      throw new Error("HOLD: DevicePushToken table exists but migration is not recorded");
    }

    console.log(
      JSON.stringify(
        {
          mode: "pre-deploy",
          host,
          pendingExpected: MIGRATION_NAME,
          devicePushTokenTable: false,
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
        throw new Error(`HOLD: ${name} count ${beforeCounts[name]} -> ${afterCounts[name]}`);
      }
    }
    const pushAfter = snapshotPush(await describeTable(prisma, "PushSubscription"));
    if (JSON.stringify(pushBefore) !== JSON.stringify(pushAfter)) {
      throw new Error("HOLD: PushSubscription structure changed");
    }

    const desc = await describeDevicePushToken(prisma);
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
          pendingBefore: pending,
          pendingAfter,
          schemaUpToDate: /Database schema is up to date/i.test(statusAfter),
          countsBefore: beforeCounts,
          countsAfter: afterCounts,
          countsUnchanged: true,
          pushSubscriptionUnchanged: true,
          ...schemaSummary(desc),
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
