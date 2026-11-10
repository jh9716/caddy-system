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
 * READ-ONLY inspect first (DB _prisma_migrations + prisma migrate status).
 * `prisma migrate deploy` runs only when the sole pending migration is
 * 20261109193000_comment_replies_v1. Any other pending/failed/unknown
 * migration aborts before deploy.
 *
 * Forbidden: db push, migrate reset, migrate dev, seed, Comment INSERT/UPDATE/DELETE
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";

const requireCjs = createRequire(__filename);
const { listRepoMigrations } = requireCjs("../preview-db/migration-state.cjs") as {
  listRepoMigrations: (dir: string) => string[];
};
const { parsePrismaMigrateStatusPending, gateSingleMigration } = requireCjs(
  "./single-migration-gate.cjs"
) as {
  parsePrismaMigrateStatusPending: (statusOut: string) => string[];
  gateSingleMigration: (input: {
    target: string;
    repo: string[];
    appliedFinished: string[];
    failedNames: string[];
    statusPending: string[];
  }) => {
    action: "deploy" | "already-applied" | "hold";
    reason: string;
    pendingFromRepo: string[];
    unexpectedPending: string[];
    unknownApplied: string[];
    statusPending: string[];
    statusUnexpected: string[];
  };
};

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

function runPrisma(url: string, args: string[]): string {
  if (args[0] !== "migrate" || (args[1] !== "status" && args[1] !== "deploy")) {
    throw new Error(`HOLD: refusing prisma ${args.join(" ")}`);
  }
  if (args[1] === "deploy" && args.length !== 2) {
    throw new Error("HOLD: prisma migrate deploy must have no extra flags");
  }
  const bin = path.join(ROOT, "node_modules", ".bin", "prisma");
  const r = spawnSync(bin, args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0 && args[1] === "deploy") {
    throw new Error(`HOLD: migrate deploy failed: ${r.stderr || r.stdout}`);
  }
  return `${r.stdout || ""}\n${r.stderr || ""}`;
}

async function commentFingerprint(prisma: PrismaClient): Promise<{ total: number; fingerprint: string }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
    `SELECT COUNT(*)::bigint AS total,
            coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') AS fingerprint
     FROM "Comment"`
  );
  return {
    total: Number(rows[0]?.total ?? -1),
    fingerprint: rows[0]?.fingerprint ?? "missing",
  };
}

async function readMigrationState(prisma: PrismaClient) {
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
  >(
    `SELECT migration_name, finished_at, rolled_back_at
     FROM "_prisma_migrations"
     ORDER BY started_at ASC NULLS LAST, migration_name ASC`
  );
  const appliedFinished = applied
    .filter((r) => r.finished_at && !r.rolled_back_at)
    .map((r) => r.migration_name);
  const failedNames = [
    ...new Set(
      applied
        .filter((r) => !r.finished_at || r.rolled_back_at)
        .map((r) => r.migration_name)
    ),
  ];
  return { appliedFinished, failedNames };
}

async function describeParentId(prisma: PrismaClient) {
  const cols = await prisma.$queryRawUnsafe<
    Array<{ column_name: string; udt_name: string; is_nullable: string }>
  >(
    `SELECT column_name, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'`
  );
  const fk = await prisma.$queryRawUnsafe<
    Array<{ constraint_name: string; delete_rule: string }>
  >(
    `SELECT tc.constraint_name, rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
     WHERE tc.table_schema='public'
       AND tc.table_name='Comment'
       AND tc.constraint_type='FOREIGN KEY'
       AND tc.constraint_name='Comment_parentId_fkey'`
  );
  return { column: cols[0] ?? null, fk: fk[0] ?? null };
}

async function parentIdCounts(prisma: PrismaClient) {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ with_parent: bigint; null_parent: bigint }>
  >(
    `SELECT COUNT(*) FILTER (WHERE "parentId" IS NOT NULL)::bigint AS with_parent,
            COUNT(*) FILTER (WHERE "parentId" IS NULL)::bigint AS null_parent
     FROM "Comment"`
  );
  return {
    withParent: Number(rows[0]?.with_parent ?? -1),
    nullParent: Number(rows[0]?.null_parent ?? -1),
  };
}

function assertParentIdSchema(desc: Awaited<ReturnType<typeof describeParentId>>): void {
  if (!desc.column) throw new Error("HOLD: Comment.parentId column missing");
  if (desc.column.is_nullable !== "YES") throw new Error("HOLD: parentId must be nullable");
  if (desc.column.udt_name !== "int4") throw new Error("HOLD: parentId must be INTEGER");
  if (!desc.fk) throw new Error("HOLD: Comment_parentId_fkey missing");
  if (desc.fk.delete_rule !== "RESTRICT") {
    throw new Error(`HOLD: parentId FK delete_rule ${desc.fk.delete_rule}, expected RESTRICT`);
  }
}

async function main() {
  const { url, host } = requireProdMaintenance(TASK_ID);
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${host}`);
  }
  const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");
  auditMigrationSql(sql);
  const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    if (!tableNames.includes("_prisma_migrations")) {
      throw new Error("HOLD: _prisma_migrations missing; refusing unexpected schema");
    }
    if (!tableNames.includes("Comment")) {
      throw new Error("HOLD: Comment table missing; comment_v1 must already be applied");
    }

    const { appliedFinished, failedNames } = await readMigrationState(prisma);
    const before = await commentFingerprint(prisma);
    const parentBefore = await describeParentId(prisma);
    console.error("comment rows before:", before.total);
    console.error("comment id fingerprint before:", before.fingerprint);

    const statusOut = runPrisma(url, ["migrate", "status"]);
    const statusPending = parsePrismaMigrateStatusPending(statusOut);
    const gate = gateSingleMigration({
      target: MIGRATION_NAME,
      repo,
      appliedFinished,
      failedNames,
      statusPending,
    });

    const inspect = {
      host,
      migration: MIGRATION_NAME,
      gate: gate.action,
      reason: gate.reason,
      pendingFromRepo: gate.pendingFromRepo,
      unexpectedPending: gate.unexpectedPending,
      unknownApplied: gate.unknownApplied,
      failedNames,
      statusPending,
      parentIdColumn: parentBefore.column,
      parentFk: parentBefore.fk,
      commentTotal: before.total,
      commentIdFingerprint: before.fingerprint,
    };

    if (gate.action === "hold") {
      console.log(JSON.stringify({ ok: false, ...inspect }, null, 2));
      throw new Error(`HOLD: ${gate.reason}`);
    }

    if (gate.action === "already-applied") {
      assertParentIdSchema(parentBefore);
      const counts = await parentIdCounts(prisma);
      if (counts.nullParent + counts.withParent !== before.total) {
        throw new Error("HOLD: Comment parentId accounting mismatch");
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "already-applied",
            ...inspect,
            parentCounts: counts,
          },
          null,
          2
        )
      );
      console.error("OK: comment replies migration already applied; no deploy");
      return;
    }

    if (parentBefore.column) {
      console.log(JSON.stringify({ ok: false, hold: "parentId exists but migration not recorded", ...inspect }, null, 2));
      throw new Error("HOLD: parentId column exists but migration is not recorded");
    }

    console.log(JSON.stringify({ ok: true, mode: "pre-deploy", ...inspect }, null, 2));
    console.error("=== prisma migrate deploy ===");
    runPrisma(url, ["migrate", "deploy"]);

    const after = await commentFingerprint(prisma);
    if (after.total !== before.total) {
      throw new Error(`HOLD: Comment row count changed ${before.total} → ${after.total}`);
    }
    if (after.fingerprint !== before.fingerprint) {
      throw new Error("HOLD: Comment id fingerprint changed; existing rows were modified");
    }
    const parentAfter = await describeParentId(prisma);
    assertParentIdSchema(parentAfter);
    const counts = await parentIdCounts(prisma);
    if (counts.withParent !== 0) {
      throw new Error(`HOLD: existing comments must stay parentId NULL, withParent=${counts.withParent}`);
    }
    if (counts.nullParent !== after.total) {
      throw new Error("HOLD: Comment parentId accounting mismatch after deploy");
    }

    const statusAfter = runPrisma(url, ["migrate", "status"]);
    const pendingAfter = parsePrismaMigrateStatusPending(statusAfter);
    if (pendingAfter.length !== 0 && !/Database schema is up to date/i.test(statusAfter)) {
      throw new Error(`HOLD: pending after deploy ${JSON.stringify(pendingAfter)}`);
    }
    const { appliedFinished: appliedAfter, failedNames: failedAfter } = await readMigrationState(prisma);
    if (!appliedAfter.includes(MIGRATION_NAME)) {
      throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
    }
    if (failedAfter.length > 0) {
      throw new Error(`HOLD: failed migrations after deploy ${JSON.stringify(failedAfter)}`);
    }

    console.error("comment rows after:", after.total);
    console.error("parentId non-null:", counts.withParent);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "deployed",
          host,
          commentTotalBefore: before.total,
          commentTotalAfter: after.total,
          commentIdFingerprint: after.fingerprint,
          countsUnchanged: true,
          parentCounts: counts,
          pendingAfter,
          parentIdColumn: parentAfter.column,
          parentFk: parentAfter.fk,
        },
        null,
        2
      )
    );
    console.error("OK: comment replies migration applied (additive parentId)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
