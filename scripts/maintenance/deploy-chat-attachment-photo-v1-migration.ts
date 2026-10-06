/**
 * Production: apply additive ChatAttachment photo V1 migration only.
 *
 * Inspect (read-only, no confirm):
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-chat-attachment-photo-v1-migration.ts --inspect-only
 *
 * Apply:
 *   PROD_MAINTENANCE_CONFIRM=CHAT_ATTACHMENT_PHOTO_V1_20261006 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-chat-attachment-photo-v1-migration.ts
 *
 * Runs only: prisma migrate status (inspect) / prisma migrate deploy (apply)
 * Forbidden: db push, migrate reset, migrate dev, seed, ad-hoc INSERT/UPDATE/DELETE
 * Forbidden: Vercel Blob write, Cloudflare redeploy, PR merge
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../../src/lib/dbSafety";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "CHAT_ATTACHMENT_PHOTO_V1_20261006";
const MIGRATION_NAME = "20261006120000_chat_attachment_photo_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");
const INSPECT_ONLY = process.argv.includes("--inspect-only");

const EXPECTED_COLUMNS = [
  "id",
  "roomId",
  "senderUserId",
  "storageKey",
  "mimeType",
  "size",
  "createdAt",
  "consumedAt",
] as const;

const EXPECTED_INDEXES = [
  "ChatAttachment_pkey",
  "ChatAttachment_storageKey_key",
  "ChatAttachment_roomId_createdAt_idx",
  "ChatAttachment_senderUserId_consumedAt_idx",
] as const;

const COUNT_TABLES = [
  "User",
  "Caddy",
  "Notice",
  "DailyBoardPublished",
  "PushSubscription",
  "CourseReport",
  "CourseReportPhoto",
  "ChatRoomNotificationPreference",
] as const;

function maskHost(host: string): string {
  const parts = host.split(".");
  if (parts.length < 3) return host.slice(0, 4) + "…";
  const first = parts[0];
  const masked = first.length > 8 ? `${first.slice(0, 4)}…${first.slice(-2)}` : first;
  return [masked, ...parts.slice(1)].join(".");
}

function sqlBody(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function auditMigrationSql(sql: string): void {
  const body = sqlBody(sql);
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
    /\bALTER\b/,
  ];
  for (const re of forbidden) {
    if (re.test(upper)) {
      throw new Error(`HOLD: migration.sql contains forbidden token ${re}`);
    }
  }
  if (/\bDELETE\b/.test(upper) || /\bUPDATE\b/.test(upper)) {
    throw new Error("HOLD: migration.sql contains DELETE/UPDATE");
  }

  const createRe = /\bCREATE\s+TABLE\b\s+"?([A-Za-z0-9_]+)"?/gi;
  const created: string[] = [];
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createRe.exec(body))) created.push(createMatch[1]);
  if (created.length !== 1 || created[0] !== "ChatAttachment") {
    throw new Error(`HOLD: expected CREATE TABLE ChatAttachment only, got ${created.join(",")}`);
  }

  if (!/CREATE\s+UNIQUE\s+INDEX\s+"ChatAttachment_storageKey_key"/i.test(body)) {
    throw new Error("HOLD: missing unique storageKey index");
  }
  if (!/CREATE\s+INDEX\s+"ChatAttachment_roomId_createdAt_idx"/i.test(body)) {
    throw new Error("HOLD: missing roomId/createdAt index");
  }
  if (!/CREATE\s+INDEX\s+"ChatAttachment_senderUserId_consumedAt_idx"/i.test(body)) {
    throw new Error("HOLD: missing senderUserId/consumedAt index");
  }
  if (/\bREFERENCES\b/i.test(body) || /\bFOREIGN\s+KEY\b/i.test(body)) {
    throw new Error("HOLD: ChatAttachment must not add a foreign key");
  }
  for (const col of EXPECTED_COLUMNS) {
    if (!body.includes(`"${col}"`)) {
      throw new Error(`HOLD: missing column ${col} in SQL`);
    }
  }
}

function runPrisma(args: string[]): string {
  if (args[0] !== "migrate" || (args[1] !== "status" && args[1] !== "deploy")) {
    throw new Error(`HOLD: refusing prisma ${args.join(" ")}`);
  }
  if (args[1] === "deploy") {
    if (INSPECT_ONLY) throw new Error("HOLD: inspect-only refuses migrate deploy");
    if (args.length !== 2) throw new Error("HOLD: prisma migrate deploy must have no extra flags");
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

async function describeAttachment(prisma: PrismaClient) {
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
     WHERE table_schema = 'public' AND table_name = 'ChatAttachment'
     ORDER BY ordinal_position`
  );
  const indexes = await prisma.$queryRawUnsafe<
    Array<{ indexname: string; indexdef: string }>
  >(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'ChatAttachment'
     ORDER BY indexname`
  );
  const fks = await prisma.$queryRawUnsafe<
    Array<{ constraint_name: string }>
  >(
    `SELECT tc.constraint_name
     FROM information_schema.table_constraints tc
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'ChatAttachment'
       AND tc.constraint_type = 'FOREIGN KEY'`
  );
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null }>
  >(
    `SELECT migration_name, finished_at
     FROM "_prisma_migrations"
     WHERE migration_name = '${MIGRATION_NAME}'`
  );
  const rows = columns.length
    ? await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        `SELECT COUNT(*)::bigint AS n FROM "ChatAttachment"`
      )
    : [{ n: -1 }];
  return { columns, indexes, fks, applied, rowCount: Number(rows[0]?.n ?? -1) };
}

function assertSchema(desc: Awaited<ReturnType<typeof describeAttachment>>): void {
  const colNames = desc.columns.map((c) => c.column_name);
  for (const col of EXPECTED_COLUMNS) {
    if (!colNames.includes(col)) throw new Error(`HOLD: missing column ${col}`);
  }
  if (colNames.length !== EXPECTED_COLUMNS.length) {
    throw new Error(`HOLD: unexpected columns: ${colNames.join(",")}`);
  }
  const idx = desc.indexes.map((i) => i.indexname);
  for (const name of EXPECTED_INDEXES) {
    if (!idx.includes(name)) throw new Error(`HOLD: missing index ${name}`);
  }
  if (desc.fks.length) {
    throw new Error(`HOLD: unexpected ChatAttachment FK ${desc.fks.map((f) => f.constraint_name).join(",")}`);
  }
  if (desc.rowCount !== 0) {
    throw new Error(`HOLD: ChatAttachment row count ${desc.rowCount}, expected 0`);
  }
  if (!desc.applied.length || !desc.applied[0]?.finished_at) {
    throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
  }
}

function requireProductionUrl(): { host: string; url: string } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없습니다.");
  const host = parseDatabaseUrl(url).hostname;
  if (!isProductionDatabaseUrl(url)) {
    throw new Error(`HOLD: inspect/apply requires production DB. host=${maskHost(host)}`);
  }
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${maskHost(host)}`);
  }
  return { host, url };
}

async function main() {
  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditMigrationSql(sql);
  console.error("SQL audit: PASS (CREATE TABLE ChatAttachment + unique + 2 indexes, no FK/drop)");

  const { host } = INSPECT_ONLY ? requireProductionUrl() : requireProdMaintenance(TASK_ID);
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${maskHost(host)}`);
  }
  console.error("host_masked:", maskHost(host));
  console.error("db:", parseDatabaseUrl(process.env.DATABASE_URL || "").pathname);

  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    const already = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const appliedCount = Number(already[0]?.n ?? 0);
    const beforeCounts = await countNamedTables(prisma, COUNT_TABLES);
    const tableExists = tableNames.includes("ChatAttachment");

    const statusOut = runPrisma(["migrate", "status"]);
    const pending = parsePending(statusOut);
    const unexpectedPending = pending.filter((name) => name !== MIGRATION_NAME);

    const inspect = {
      ok: unexpectedPending.length === 0,
      mode: INSPECT_ONLY ? "inspect-only" : "pre-deploy",
      hostMasked: maskHost(host),
      db: parseDatabaseUrl(process.env.DATABASE_URL || "").pathname.replace(/^\//, ""),
      migration: MIGRATION_NAME,
      appliedCount,
      chatAttachmentTableExists: tableExists,
      pending,
      unexpectedPending,
      counts: beforeCounts,
      sqlDestructive: false,
    };

    if (unexpectedPending.length) {
      console.log(JSON.stringify({ ...inspect, hold: "unexpected pending migrations" }, null, 2));
      throw new Error(`HOLD: unexpected pending migrations ${JSON.stringify(unexpectedPending)}`);
    }

    if (INSPECT_ONLY) {
      console.log(JSON.stringify(inspect, null, 2));
      return;
    }

    if (appliedCount === 1) {
      if (!tableExists) {
        throw new Error("HOLD: migration recorded but ChatAttachment table missing");
      }
      const desc = await describeAttachment(prisma);
      assertSchema(desc);
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "already-applied",
            hostMasked: maskHost(host),
            migration: MIGRATION_NAME,
            counts: beforeCounts,
            chatAttachmentRows: desc.rowCount,
            columns: desc.columns.map((c) => c.column_name),
            indexes: desc.indexes.map((i) => i.indexname),
            fks: desc.fks,
          },
          null,
          2
        )
      );
      return;
    }

    if (tableExists) {
      throw new Error("HOLD: ChatAttachment exists but migration is not recorded");
    }

    if (pending.length !== 1 || pending[0] !== MIGRATION_NAME) {
      throw new Error(
        `HOLD: pending migrations ${JSON.stringify(pending)} — only ${MIGRATION_NAME} is allowed`
      );
    }

    console.log(JSON.stringify({ ...inspect, mode: "pre-deploy" }, null, 2));
    console.error("=== prisma migrate deploy ===");
    runPrisma(["migrate", "deploy"]);

    const afterCounts = await countNamedTables(prisma, COUNT_TABLES);
    for (const name of COUNT_TABLES) {
      if (afterCounts[name] !== beforeCounts[name]) {
        throw new Error(`HOLD: ${name} count ${beforeCounts[name]} -> ${afterCounts[name]}`);
      }
    }
    const desc = await describeAttachment(prisma);
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
          hostMasked: maskHost(host),
          migration: MIGRATION_NAME,
          countsBefore: beforeCounts,
          countsAfter: afterCounts,
          countsUnchanged: true,
          chatAttachmentRows: desc.rowCount,
          columns: desc.columns.map((c) => ({
            name: c.column_name,
            type: c.udt_name,
            nullable: c.is_nullable,
            default: c.column_default,
          })),
          indexes: desc.indexes.map((i) => i.indexname),
          fks: desc.fks,
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
