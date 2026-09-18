/**
 * Production: apply additive Notice V2 migration only.
 *
 *   PROD_MAINTENANCE_CONFIRM=NOTICE_V2_20260918 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-notice-v2-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "NOTICE_V2_20260918";
const MIGRATION_NAME = "20260918120000_notice_v2";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

const NEW_COLUMNS = [
  "important",
  "pinned",
  "targetType",
  "targetValue",
  "publishStartAt",
  "publishEndAt",
  "pushSentAt",
  "pushSentByUserId",
] as const;

const IDENTITY_COLUMNS = [
  "id",
  "title",
  "content",
  "author",
  "createdAt",
  "updatedAt",
] as const;

const EXPECTED_INDEXES = [
  "Notice_pinned_important_createdAt_idx",
  "Notice_targetType_targetValue_idx",
] as const;

type NoticeIdentity = {
  id: number;
  title: string;
  content: string;
  author: string | null;
  createdAt: Date;
  updatedAt: Date;
};

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
    /\bDELETE\s+FROM\b/,
    /\bUPDATE\s+"?[A-Z0-9_]+"?\s+SET\b/,
    /\bDB\s+PUSH\b/,
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
  if (/\bCREATE\s+TABLE\b/.test(upper)) {
    throw new Error("HOLD: CREATE TABLE is not allowed for Notice V2");
  }

  const alterRe = /\bALTER\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let alterMatch: RegExpExecArray | null;
  let alters = 0;
  while ((alterMatch = alterRe.exec(body))) {
    alters += 1;
    if (alterMatch[1] !== "Notice") {
      throw new Error(`HOLD: ALTER TABLE on ${alterMatch[1]} (Notice only)`);
    }
    const rest = body.slice(alterMatch.index, alterMatch.index + 280).toUpperCase();
    if (!/\bADD\s+COLUMN\b/.test(rest)) {
      throw new Error("HOLD: Notice ALTER is not ADD COLUMN");
    }
    if (/\bDROP\b/.test(rest) || /\bALTER\s+COLUMN\b/.test(rest) || /\bTYPE\b/.test(rest)) {
      throw new Error("HOLD: destructive ALTER on Notice");
    }
  }
  if (alters !== 8) {
    throw new Error(`HOLD: expected 8 ALTER TABLE ADD COLUMN, got ${alters}`);
  }

  const indexRe = /\bCREATE\s+INDEX\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const indexes: string[] = [];
  let indexMatch: RegExpExecArray | null;
  while ((indexMatch = indexRe.exec(body))) {
    indexes.push(indexMatch[1]);
  }
  if (indexes.length !== 2) {
    throw new Error(`HOLD: expected 2 CREATE INDEX, got ${indexes.length}`);
  }
  for (const name of EXPECTED_INDEXES) {
    if (!indexes.includes(name)) {
      throw new Error(`HOLD: missing CREATE INDEX ${name}`);
    }
  }
  for (const col of NEW_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing ADD COLUMN ${col}`);
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

function identityFingerprint(rows: NoticeIdentity[]): string {
  const payload = rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    author: r.author,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function loadIdentity(prisma: PrismaClient): Promise<NoticeIdentity[]> {
  return prisma.$queryRawUnsafe<NoticeIdentity[]>(
    `SELECT id, title, content, author, "createdAt", "updatedAt"
     FROM "Notice"
     ORDER BY id ASC`
  );
}

async function noticeCount(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "Notice"`
  );
  return Number(rows[0]?.n ?? 0);
}

async function describeNotice(prisma: PrismaClient) {
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
     WHERE table_schema = 'public' AND table_name = 'Notice'
     ORDER BY ordinal_position`
  );
  const indexes = await prisma.$queryRawUnsafe<
    Array<{ indexname: string; indexdef: string }>
  >(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'Notice'
     ORDER BY indexname`
  );
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null }>
  >(
    `SELECT migration_name, finished_at
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  const defaults = await prisma.$queryRawUnsafe<
    Array<{
      n: bigint | number;
      important_false: bigint | number;
      pinned_false: bigint | number;
      target_all: bigint | number;
      target_value_null: bigint | number;
      start_null: bigint | number;
      end_null: bigint | number;
      push_sent_null: bigint | number;
      push_by_null: bigint | number;
    }>
  >(
    `SELECT
       COUNT(*)::bigint AS n,
       COUNT(*) FILTER (WHERE important = false)::bigint AS important_false,
       COUNT(*) FILTER (WHERE pinned = false)::bigint AS pinned_false,
       COUNT(*) FILTER (WHERE "targetType" = 'ALL')::bigint AS target_all,
       COUNT(*) FILTER (WHERE "targetValue" IS NULL)::bigint AS target_value_null,
       COUNT(*) FILTER (WHERE "publishStartAt" IS NULL)::bigint AS start_null,
       COUNT(*) FILTER (WHERE "publishEndAt" IS NULL)::bigint AS end_null,
       COUNT(*) FILTER (WHERE "pushSentAt" IS NULL)::bigint AS push_sent_null,
       COUNT(*) FILTER (WHERE "pushSentByUserId" IS NULL)::bigint AS push_by_null
     FROM "Notice"`
  );
  return { columns, indexes, applied, defaults: defaults[0] };
}

function assertSchema(
  desc: Awaited<ReturnType<typeof describeNotice>>,
  expectedCount: number
): void {
  const colNames = desc.columns.map((c) => c.column_name);
  for (const col of IDENTITY_COLUMNS) {
    if (!colNames.includes(col)) throw new Error(`HOLD: missing identity column ${col}`);
  }
  for (const col of NEW_COLUMNS) {
    if (!colNames.includes(col)) throw new Error(`HOLD: missing new column ${col}`);
  }
  const important = desc.columns.find((c) => c.column_name === "important");
  const pinned = desc.columns.find((c) => c.column_name === "pinned");
  const targetType = desc.columns.find((c) => c.column_name === "targetType");
  if (important?.is_nullable !== "NO" || !/false/i.test(String(important.column_default))) {
    throw new Error("HOLD: important is not BOOLEAN NOT NULL DEFAULT false");
  }
  if (pinned?.is_nullable !== "NO" || !/false/i.test(String(pinned.column_default))) {
    throw new Error("HOLD: pinned is not BOOLEAN NOT NULL DEFAULT false");
  }
  if (targetType?.is_nullable !== "NO" || !/ALL/.test(String(targetType.column_default))) {
    throw new Error("HOLD: targetType is not TEXT NOT NULL DEFAULT ALL");
  }
  const idx = desc.indexes.map((i) => i.indexname);
  for (const name of EXPECTED_INDEXES) {
    if (!idx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
  const d = desc.defaults;
  const n = Number(d.n ?? -1);
  if (n !== expectedCount) {
    throw new Error(`HOLD: Notice count ${n} != expected ${expectedCount}`);
  }
  const checks: Array<[string, bigint | number]> = [
    ["important_false", d.important_false],
    ["pinned_false", d.pinned_false],
    ["target_all", d.target_all],
    ["target_value_null", d.target_value_null],
    ["start_null", d.start_null],
    ["end_null", d.end_null],
    ["push_sent_null", d.push_sent_null],
    ["push_by_null", d.push_by_null],
  ];
  for (const [label, value] of checks) {
    if (Number(value) !== n) {
      throw new Error(`HOLD: default check ${label}=${value} expected ${n}`);
    }
  }
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error("SQL audit: PASS (8 ADD COLUMN + 2 INDEX on Notice)");

  const { host } = requireProdMaintenance(TASK_ID);
  const prisma = new PrismaClient();
  try {
    const beforeCount = await noticeCount(prisma);
    const beforeRows = await loadIdentity(prisma);
    const beforeFp = identityFingerprint(beforeRows);
    const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const appliedCount = Number(already[0]?.n ?? 0);

    if (appliedCount === 1) {
      const desc = await describeNotice(prisma);
      assertSchema(desc, beforeCount);
      const afterRows = await loadIdentity(prisma);
      const afterFp = identityFingerprint(afterRows);
      if (afterFp !== beforeFp) {
        throw new Error("HOLD: Notice identity fingerprint changed on already-applied path");
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "already-applied",
            host,
            migration: MIGRATION_NAME,
            noticeCount: beforeCount,
            identityFingerprint: beforeFp,
            columns: desc.columns.map((c) => c.column_name),
            indexes: desc.indexes.map((i) => i.indexname),
            defaultsOk: true,
            identityUnchanged: true,
          },
          null,
          2
        )
      );
      return;
    }

    const colNames = (
      await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Notice'`
      )
    ).map((c) => c.column_name);
    const alreadyHasNew = NEW_COLUMNS.every((c) => colNames.includes(c));
    if (alreadyHasNew) {
      throw new Error("HOLD: Notice V2 columns exist but migration is not recorded");
    }

    console.log(
      JSON.stringify(
        {
          mode: "pre-deploy",
          host,
          pendingExpected: MIGRATION_NAME,
          noticeCount: beforeCount,
          identityFingerprint: beforeFp,
        },
        null,
        2
      )
    );

    const statusOut = runPrisma(["migrate", "status"]);
    const pending = parsePending(statusOut);
    if (pending.length === 0) {
      throw new Error("HOLD: migrate status reported no pending, but migration is not recorded");
    }
    if (pending.length !== 1 || pending[0] !== MIGRATION_NAME) {
      throw new Error(
        `HOLD: pending migrations ${JSON.stringify(pending)} — only ${MIGRATION_NAME} is allowed`
      );
    }

    console.error("=== prisma migrate deploy ===");
    runPrisma(["migrate", "deploy"]);

    const afterCount = await noticeCount(prisma);
    if (afterCount !== beforeCount) {
      throw new Error(`HOLD: Notice count ${beforeCount} -> ${afterCount}`);
    }
    const afterRows = await loadIdentity(prisma);
    const afterFp = identityFingerprint(afterRows);
    if (afterFp !== beforeFp) {
      throw new Error("HOLD: Notice identity fingerprint changed after deploy");
    }
    const desc = await describeNotice(prisma);
    assertSchema(desc, beforeCount);

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "deployed",
          host,
          migration: MIGRATION_NAME,
          noticeCountBefore: beforeCount,
          noticeCountAfter: afterCount,
          identityFingerprint: afterFp,
          identityUnchanged: true,
          columns: desc.columns.map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable,
            default: c.column_default,
          })),
          indexes: desc.indexes.map((i) => i.indexname),
          defaultsOk: true,
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
