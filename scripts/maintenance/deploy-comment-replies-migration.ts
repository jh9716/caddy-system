/**
 * Production: apply additive Comment replies (parentId) migration only.
 *
 * Deploy order (required):
 *   1. Preview DB migrate deploy (separate approval) and verify.
 *   2. This script on production.
 *   3. Only then release app code that SELECTs Comment.parentId.
 *
 *   PROD_MAINTENANCE_CONFIRM=COMMENT_REPLIES_V1_20261109 \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-comment-replies-migration.ts
 *
 * Runs only: prisma migrate deploy
 * Forbidden: db push, migrate reset, migrate dev, seed, Comment INSERT/UPDATE/DELETE
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const TASK_ID = "COMMENT_REPLIES_V1_20261109";
const MIGRATION_NAME = "20261109193000_comment_replies_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
const ROOT = path.resolve(__dirname, "../..");

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
  if (!/ALTER\s+TABLE\s+"Comment"\s+ADD\s+COLUMN\s+"parentId"\s+INTEGER/i.test(body)) {
    throw new Error("HOLD: expected additive Comment.parentId INTEGER");
  }
  if (!/ON\s+DELETE\s+RESTRICT/i.test(body)) {
    throw new Error("HOLD: parentId FK must be ON DELETE RESTRICT");
  }
  if (/ON\s+DELETE\s+CASCADE/i.test(body)) {
    throw new Error("HOLD: replies migration must not CASCADE delete");
  }
}

async function main() {
  const { url, host } = requireProdMaintenance(TASK_ID);
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${host}`);
  }
  const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");
  auditMigrationSql(sql);

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const before = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "Comment"`
    );
    const beforeN = Number(before[0]?.n ?? -1);
    console.error("comment rows before:", beforeN);

    const result = spawnSync(
      path.join(ROOT, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy"],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(`HOLD: migrate deploy failed: ${result.stderr || result.stdout}`);
    }

    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'`
    );
    if (cols[0]?.is_nullable !== "YES") {
      throw new Error("HOLD: parentId must be nullable");
    }
    const after = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "Comment"`
    );
    const afterN = Number(after[0]?.n ?? -1);
    if (afterN !== beforeN) {
      throw new Error(`HOLD: Comment row count changed ${beforeN} → ${afterN}`);
    }
    const filled = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "Comment" WHERE "parentId" IS NOT NULL`
    );
    console.error("comment rows after:", afterN);
    console.error("parentId non-null:", Number(filled[0]?.n ?? 0));
    console.error("OK: comment replies migration applied (additive parentId)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
