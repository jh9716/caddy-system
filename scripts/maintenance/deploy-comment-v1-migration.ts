/**
 * Production: apply additive Comment V1 migration only.
 *
 *   PROD_MAINTENANCE_CONFIRM=COMMENT_V1_20260919 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-comment-v1-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 * Forbidden: CourseReport/Comment row create, Blob, PushSubscription write
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "COMMENT_V1_20260919";
const MIGRATION_NAME = "20260919070000_comment_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

const EXPECTED_ENUM = ["COURSE_REPORT", "BOARD_DATE", "NOTICE"] as const;

const EXPECTED_THREAD_COLUMNS = [
  "id",
  "targetType",
  "targetKey",
  "createdAt",
  "updatedAt",
] as const;

const EXPECTED_COMMENT_COLUMNS = [
  "id",
  "threadId",
  "authorUserId",
  "body",
  "deletedAt",
  "createdAt",
  "updatedAt",
] as const;

const EXPECTED_THREAD_INDEXES = [
  "CommentThread_pkey",
  "CommentThread_targetType_targetKey_key",
  "CommentThread_targetType_targetKey_idx",
] as const;

const EXPECTED_COMMENT_INDEXES = [
  "Comment_pkey",
  "Comment_threadId_createdAt_idx",
  "Comment_authorUserId_idx",
] as const;

const COUNT_TABLES = [
  "User",
  "Caddy",
  "Notice",
  "CourseReport",
  "CourseReportPhoto",
  "DailyBoardPublished",
  "PushSubscription",
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

  const typeRe = /\bCREATE\s+TYPE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const types: string[] = [];
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRe.exec(body))) types.push(typeMatch[1]);
  if (types.length !== 1 || types[0] !== "CommentTargetType") {
    throw new Error(`HOLD: expected CREATE TYPE CommentTargetType only, got ${types.join(",")}`);
  }
  if (
    !/CREATE\s+TYPE\s+"CommentTargetType"\s+AS\s+ENUM\s*\(\s*'COURSE_REPORT'\s*,\s*'BOARD_DATE'\s*,\s*'NOTICE'\s*\)/i.test(
      body
    )
  ) {
    throw new Error("HOLD: CommentTargetType enum values must be COURSE_REPORT, BOARD_DATE, NOTICE");
  }

  const createRe = /\bCREATE\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const created: string[] = [];
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createRe.exec(body))) created.push(createMatch[1]);
  if (
    created.length !== 2 ||
    created[0] !== "CommentThread" ||
    created[1] !== "Comment"
  ) {
    throw new Error(
      `HOLD: expected CREATE TABLE CommentThread then Comment, got ${created.join(",")}`
    );
  }

  if (!/CREATE\s+UNIQUE\s+INDEX\s+"CommentThread_targetType_targetKey_key"/i.test(body)) {
    throw new Error("HOLD: missing unique (targetType, targetKey)");
  }
  if (!/CREATE\s+INDEX\s+"CommentThread_targetType_targetKey_idx"/i.test(body)) {
    throw new Error("HOLD: missing CommentThread target index");
  }
  if (!/CREATE\s+INDEX\s+"Comment_threadId_createdAt_idx"/i.test(body)) {
    throw new Error("HOLD: missing Comment threadId/createdAt index");
  }
  if (!/CREATE\s+INDEX\s+"Comment_authorUserId_idx"/i.test(body)) {
    throw new Error("HOLD: missing Comment authorUserId index");
  }

  const alterRe = /\bALTER\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  let alters = 0;
  let alterMatch: RegExpExecArray | null;
  while ((alterMatch = alterRe.exec(body))) {
    alters += 1;
    if (alterMatch[1] !== "Comment") {
      throw new Error(`HOLD: ALTER TABLE on unexpected table ${alterMatch[1]}`);
    }
    const rest = body.slice(alterMatch.index, alterMatch.index + 500).toUpperCase();
    if (!/\bADD\s+CONSTRAINT\b/.test(rest)) {
      throw new Error("HOLD: Comment ALTER is not ADD CONSTRAINT");
    }
    if (/\bDROP\b/.test(rest) || /\bALTER\s+COLUMN\b/.test(rest) || /\bADD\s+COLUMN\b/.test(rest)) {
      throw new Error("HOLD: destructive/extra ALTER on Comment");
    }
  }
  if (alters !== 2) {
    throw new Error(`HOLD: expected 2 ALTER TABLE ADD CONSTRAINT, got ${alters}`);
  }
  if (
    !/FOREIGN KEY \("threadId"\) REFERENCES "CommentThread"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/.test(
      body
    )
  ) {
    throw new Error("HOLD: threadId FK is not CommentThread ON DELETE CASCADE");
  }
  if (
    !/FOREIGN KEY \("authorUserId"\) REFERENCES "User"\("id"\)\s+ON DELETE RESTRICT ON UPDATE CASCADE/.test(
      body
    )
  ) {
    throw new Error("HOLD: authorUserId FK is not User ON DELETE RESTRICT");
  }
  for (const col of EXPECTED_THREAD_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing CommentThread column ${col} in SQL`);
    }
  }
  for (const col of EXPECTED_COMMENT_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing Comment column ${col} in SQL`);
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

async function describeColumns(prisma: PrismaClient, table: string) {
  return prisma.$queryRawUnsafe<
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
}

async function describeIndexes(prisma: PrismaClient, table: string) {
  return prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = '${table}'
     ORDER BY indexname`
  );
}

async function describeFks(prisma: PrismaClient, table: string) {
  return prisma.$queryRawUnsafe<
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
}

async function describeCommentSchema(prisma: PrismaClient) {
  const enumValues = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
    `SELECT e.enumlabel
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'CommentTargetType'
     ORDER BY e.enumsortorder`
  );
  const threadColumns = await describeColumns(prisma, "CommentThread");
  const commentColumns = await describeColumns(prisma, "Comment");
  const threadIndexes = await describeIndexes(prisma, "CommentThread");
  const commentIndexes = await describeIndexes(prisma, "Comment");
  const commentFks = await describeFks(prisma, "Comment");
  const applied = await prisma.$queryRawUnsafe<
    Array<{
      migration_name: string;
      finished_at: Date | null;
      checksum: string;
    }>
  >(
    `SELECT migration_name, finished_at, checksum
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  const threadRows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "CommentThread"`
  );
  const commentRows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "Comment"`
  );
  return {
    enumValues: enumValues.map((e) => e.enumlabel),
    threadColumns,
    commentColumns,
    threadIndexes,
    commentIndexes,
    commentFks,
    applied,
    commentThreadRows: Number(threadRows[0]?.n ?? -1),
    commentRows: Number(commentRows[0]?.n ?? -1),
  };
}

function assertSchema(desc: Awaited<ReturnType<typeof describeCommentSchema>>): void {
  if (desc.enumValues.join(",") !== EXPECTED_ENUM.join(",")) {
    throw new Error(`HOLD: CommentTargetType values ${desc.enumValues.join(",")}`);
  }
  const threadCols = desc.threadColumns.map((c) => c.column_name);
  for (const col of EXPECTED_THREAD_COLUMNS) {
    if (!threadCols.includes(col)) throw new Error(`HOLD: missing CommentThread column ${col}`);
  }
  if (threadCols.length !== EXPECTED_THREAD_COLUMNS.length) {
    throw new Error(`HOLD: unexpected CommentThread columns: ${threadCols.join(",")}`);
  }
  const commentCols = desc.commentColumns.map((c) => c.column_name);
  for (const col of EXPECTED_COMMENT_COLUMNS) {
    if (!commentCols.includes(col)) throw new Error(`HOLD: missing Comment column ${col}`);
  }
  if (commentCols.length !== EXPECTED_COMMENT_COLUMNS.length) {
    throw new Error(`HOLD: unexpected Comment columns: ${commentCols.join(",")}`);
  }
  const threadIdx = desc.threadIndexes.map((i) => i.indexname);
  for (const name of EXPECTED_THREAD_INDEXES) {
    if (!threadIdx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  const commentIdx = desc.commentIndexes.map((i) => i.indexname);
  for (const name of EXPECTED_COMMENT_INDEXES) {
    if (!commentIdx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  const threadFk = desc.commentFks.find((f) => f.constraint_name === "Comment_threadId_fkey");
  if (
    !threadFk ||
    threadFk.foreign_table !== "CommentThread" ||
    threadFk.column_name !== "threadId" ||
    threadFk.delete_rule !== "CASCADE"
  ) {
    throw new Error("HOLD: threadId FK is not CommentThread CASCADE");
  }
  const authorFk = desc.commentFks.find((f) => f.constraint_name === "Comment_authorUserId_fkey");
  if (
    !authorFk ||
    authorFk.foreign_table !== "User" ||
    authorFk.column_name !== "authorUserId" ||
    authorFk.delete_rule !== "RESTRICT"
  ) {
    throw new Error("HOLD: authorUserId FK is not User RESTRICT");
  }
  if (desc.commentThreadRows !== 0) {
    throw new Error(`HOLD: CommentThread row count ${desc.commentThreadRows}, expected 0`);
  }
  if (desc.commentRows !== 0) {
    throw new Error(`HOLD: Comment row count ${desc.commentRows}, expected 0`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
}

function schemaSummary(desc: Awaited<ReturnType<typeof describeCommentSchema>>) {
  return {
    enum: desc.enumValues,
    commentThreadColumns: desc.threadColumns.map((c) => ({
      name: c.column_name,
      type: c.udt_name,
      nullable: c.is_nullable,
      default: c.column_default,
    })),
    commentColumns: desc.commentColumns.map((c) => ({
      name: c.column_name,
      type: c.udt_name,
      nullable: c.is_nullable,
      default: c.column_default,
    })),
    commentThreadIndexes: desc.threadIndexes.map((i) => i.indexname),
    commentIndexes: desc.commentIndexes.map((i) => i.indexname),
    fks: desc.commentFks.map((f) => ({
      name: f.constraint_name,
      column: f.column_name,
      references: `${f.foreign_table}.${f.foreign_column}`,
      delete: f.delete_rule,
      update: f.update_rule,
    })),
    commentThreadRows: desc.commentThreadRows,
    commentRows: desc.commentRows,
    migration: desc.applied[0] ?? null,
  };
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error(
    "SQL audit: PASS (CREATE TYPE CommentTargetType + CommentThread + Comment + indexes + FKs)"
  );

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
    if (!tableNames.includes("User")) {
      throw new Error("HOLD: User table missing; comment author FK depends on it");
    }
    const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const appliedCount = Number(already[0]?.n ?? 0);
    const beforeCounts = await countNamedTables(prisma, COUNT_TABLES);
    const threadExists = await tableExists(prisma, "CommentThread");
    const commentExists = await tableExists(prisma, "Comment");

    if (appliedCount === 1) {
      if (!threadExists || !commentExists) {
        throw new Error("HOLD: migration recorded but Comment tables missing");
      }
      const desc = await describeCommentSchema(prisma);
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

    if (threadExists || commentExists) {
      throw new Error("HOLD: Comment tables exist but migration is not recorded");
    }

    console.log(
      JSON.stringify(
        {
          mode: "pre-deploy",
          host,
          pendingExpected: MIGRATION_NAME,
          commentThreadTable: false,
          commentTable: false,
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
    const desc = await describeCommentSchema(prisma);
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
          countsBefore: beforeCounts,
          countsAfter: afterCounts,
          countsUnchanged: true,
          pendingAfter,
          schemaUpToDate: /Database schema is up to date/i.test(statusAfter),
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
