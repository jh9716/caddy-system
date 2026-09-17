/**
 * Production: apply additive PushSubscription migration only.
 *
 *   PROD_MAINTENANCE_CONFIRM=PUSH_SUBSCRIPTION_V1_20260917 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-push-subscription-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "PUSH_SUBSCRIPTION_V1_20260917";
const MIGRATION_NAME = "20260917200000_push_subscription";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

const EXPECTED_COLUMNS = [
  "id",
  "userId",
  "endpoint",
  "p256dh",
  "auth",
  "userAgent",
  "platform",
  "enabled",
  "createdAt",
  "updatedAt",
  "lastSuccessAt",
  "lastFailureAt",
] as const;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
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
    /\bDELETE\s+FROM\b/,
    /\bUPDATE\s+"?[A-Z0-9_]+"?\s+SET\b/,
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

  const alterRe = /\bALTER\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let alterMatch: RegExpExecArray | null;
  while ((alterMatch = alterRe.exec(body))) {
    const table = alterMatch[1];
    if (table !== "PushSubscription") {
      throw new Error(`HOLD: ALTER TABLE on existing table ${table}`);
    }
    const rest = body.slice(alterMatch.index, alterMatch.index + 400).toUpperCase();
    if (!/\bADD\s+CONSTRAINT\b/.test(rest)) {
      throw new Error("HOLD: PushSubscription ALTER is not ADD CONSTRAINT");
    }
    if (/\bDROP\b/.test(rest) || /\bALTER\s+COLUMN\b/.test(rest)) {
      throw new Error("HOLD: destructive ALTER on PushSubscription");
    }
  }

  const createRe = /\bCREATE\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let createMatch: RegExpExecArray | null;
  let created = 0;
  while ((createMatch = createRe.exec(body))) {
    if (createMatch[1] !== "PushSubscription") {
      throw new Error(`HOLD: CREATE TABLE ${createMatch[1]} is not allowed`);
    }
    created += 1;
  }
  if (created !== 1) {
    throw new Error(`HOLD: expected exactly 1 CREATE TABLE PushSubscription, got ${created}`);
  }

  if (!body.includes('CREATE UNIQUE INDEX "PushSubscription_endpoint_key"')) {
    throw new Error("HOLD: missing endpoint unique index");
  }
  if (!body.includes('CREATE INDEX "PushSubscription_userId_idx"')) {
    throw new Error("HOLD: missing userId index");
  }
  if (!body.includes('CONSTRAINT "PushSubscription_userId_fkey"')) {
    throw new Error("HOLD: missing User FK");
  }
  if (!/FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE/.test(body)) {
    throw new Error("HOLD: User FK is not ON DELETE CASCADE");
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
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0 && args[1] === "deploy") {
    throw new Error(`prisma migrate deploy failed (exit ${r.status})`);
  }
  return out;
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

async function listPublicTables(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return rows
    .map((r) => r.table_name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
}

async function countTables(
  prisma: PrismaClient,
  tables: string[]
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

async function describePushSubscription(prisma: PrismaClient) {
  const columns = await prisma.$queryRawUnsafe<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  >(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'PushSubscription'
     ORDER BY ordinal_position`
  );
  const indexes = await prisma.$queryRawUnsafe<
    Array<{ indexname: string; indexdef: string }>
  >(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'PushSubscription'
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
       AND tc.table_name = 'PushSubscription'
       AND tc.constraint_type = 'FOREIGN KEY'`
  );
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null }>
  >(
    `SELECT migration_name, finished_at
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  return { columns, indexes, fks, applied };
}

function assertSchema(desc: Awaited<ReturnType<typeof describePushSubscription>>): void {
  const colNames = desc.columns.map((c) => c.column_name);
  for (const col of EXPECTED_COLUMNS) {
    if (!colNames.includes(col)) {
      throw new Error(`HOLD: missing column ${col}`);
    }
  }
  if (colNames.length !== EXPECTED_COLUMNS.length) {
    throw new Error(`HOLD: unexpected columns: ${colNames.join(",")}`);
  }
  const idx = desc.indexes.map((i) => i.indexname);
  if (!idx.includes("PushSubscription_endpoint_key")) {
    throw new Error("HOLD: endpoint unique index missing");
  }
  if (!idx.includes("PushSubscription_userId_idx")) {
    throw new Error("HOLD: userId index missing");
  }
  const endpoint = desc.indexes.find((i) => i.indexname === "PushSubscription_endpoint_key");
  if (!endpoint || !/UNIQUE/i.test(endpoint.indexdef)) {
    throw new Error("HOLD: endpoint index is not UNIQUE");
  }
  const fk = desc.fks.find((f) => f.constraint_name === "PushSubscription_userId_fkey");
  if (!fk) throw new Error("HOLD: User FK missing");
  if (fk.column_name !== "userId" || fk.foreign_table !== "User" || fk.foreign_column !== "id") {
    throw new Error("HOLD: User FK target mismatch");
  }
  if (fk.delete_rule !== "CASCADE") {
    throw new Error(`HOLD: User FK ON DELETE is ${fk.delete_rule}, expected CASCADE`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error("SQL audit: PASS (additive CREATE TABLE PushSubscription only)");

  const { host } = requireProdMaintenance(TASK_ID);
  const prisma = new PrismaClient();
  try {
    const tablesBefore = await listPublicTables(prisma);
    if (tablesBefore.includes("PushSubscription")) {
      const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
      );
      if (Number(already[0]?.n ?? 0) === 1) {
        const desc = await describePushSubscription(prisma);
        assertSchema(desc);
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
          `SELECT COUNT(*)::bigint AS n FROM "PushSubscription"`
        );
        const n = Number(rows[0]?.n ?? -1);
        if (n !== 0) throw new Error(`HOLD: PushSubscription row count ${n}, expected 0`);
        console.log(
          JSON.stringify(
            {
              mode: "already-applied",
              host,
              migration: MIGRATION_NAME,
              pushSubscriptionRows: n,
            },
            null,
            2
          )
        );
        return;
      }
      throw new Error("HOLD: PushSubscription table exists but migration is not recorded");
    }

    const countTargets = tablesBefore.filter((t) => t !== "PushSubscription");
    const before = await countTables(prisma, countTargets);
    console.log(
      JSON.stringify(
        {
          mode: "pre-deploy",
          host,
          pendingExpected: MIGRATION_NAME,
          tableCount: countTargets.length,
          rowCounts: before,
        },
        null,
        2
      )
    );

    const statusOut = runPrisma(["migrate", "status"]);
    const pending = parsePending(statusOut);
    if (pending.length === 0) {
      throw new Error("HOLD: migrate status reported no pending, but table is missing");
    }
    if (pending.length !== 1 || pending[0] !== MIGRATION_NAME) {
      throw new Error(
        `HOLD: pending migrations ${JSON.stringify(pending)} — only ${MIGRATION_NAME} is allowed`
      );
    }

    console.error("=== prisma migrate deploy ===");
    const deployOut = runPrisma(["migrate", "deploy"]);
    if (!/No pending migrations to apply|Applied migration|already been applied/i.test(deployOut) &&
        !deployOut.includes(MIGRATION_NAME)) {
      // prisma prints "Applying migration `name`" / "The following migration(s) have been applied"
      console.error("deploy output did not mention the expected migration name; continuing to verify");
    }

    const tablesAfter = await listPublicTables(prisma);
    if (!tablesAfter.includes("PushSubscription")) {
      throw new Error("HOLD: PushSubscription table missing after deploy");
    }
    const desc = await describePushSubscription(prisma);
    assertSchema(desc);

    const afterBase = await countTables(
      prisma,
      tablesAfter.filter((t) => t !== "PushSubscription")
    );
    const drift: string[] = [];
    for (const name of countTargets) {
      if (before[name] !== afterBase[name]) {
        drift.push(`${name}: ${before[name]} -> ${afterBase[name]}`);
      }
    }
    if (drift.length) {
      throw new Error(`HOLD: existing table row counts changed: ${drift.join("; ")}`);
    }

    const pushRows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "PushSubscription"`
    );
    const n = Number(pushRows[0]?.n ?? -1);
    if (n !== 0) {
      throw new Error(`HOLD: PushSubscription row count ${n}, expected 0 (no INSERT allowed)`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "deployed",
          host,
          migration: MIGRATION_NAME,
          columns: desc.columns.map((c) => c.column_name),
          indexes: desc.indexes.map((i) => i.indexname),
          foreignKeys: desc.fks.map((f) => ({
            name: f.constraint_name,
            from: f.column_name,
            to: `${f.foreign_table}.${f.foreign_column}`,
            onDelete: f.delete_rule,
          })),
          pushSubscriptionRows: n,
          existingTableCountsUnchanged: true,
          existingTableCount: countTargets.length,
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
