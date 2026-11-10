/**
 * Production READ ONLY: Comment.parentId column / FK / null counts / migration gate.
 * WRITE 금지. migrate 금지. 댓글 본문·작성자 등 개인정보 미출력.
 *
 *   npx tsx scripts/inspect-comment-replies-prod-readonly.ts
 */
import { createRequire } from "node:module";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const requireCjs = createRequire(__filename);
const { listRepoMigrations } = requireCjs("./preview-db/migration-state.cjs") as {
  listRepoMigrations: (dir: string) => string[];
};
const { gateSingleMigration } = requireCjs("./maintenance/single-migration-gate.cjs") as {
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
  };
};

const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const MIGRATION_NAME = "20261109193000_comment_replies_v1";
const ROOT = path.resolve(__dirname, "..");

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

async function main() {
  assertReadOnly();
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("PRODUCTION_DATABASE_URL required (read-only)");
  if (!isProductionDatabaseUrl(url)) {
    throw new Error("PRODUCTION_DATABASE_URL does not look like production");
  }
  const host = parseDatabaseUrl(url).hostname;
  if (host !== EXPECTED_HOST) throw new Error(`unexpected host ${host}`);
  const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    const hasPm = tableNames.includes("_prisma_migrations");
    const hasComment = tableNames.includes("Comment");

    const applied = hasPm
      ? await prisma.$queryRawUnsafe<
          Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
        >(
          `SELECT migration_name, finished_at, rolled_back_at
           FROM "_prisma_migrations"
           ORDER BY started_at ASC NULLS LAST, migration_name ASC`
        )
      : [];
    const appliedFinished = applied
      .filter((r) => r.finished_at && !r.rolled_back_at)
      .map((r) => r.migration_name);
    const failedNames = [
      ...new Set(
        applied.filter((r) => !r.finished_at || r.rolled_back_at).map((r) => r.migration_name)
      ),
    ];
    const thisMig = applied.filter((r) => r.migration_name === MIGRATION_NAME);

    const col = hasComment
      ? await prisma.$queryRawUnsafe<
          Array<{ column_name: string; udt_name: string; is_nullable: string }>
        >(
          `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
           WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'`
        )
      : [];
    const parentIdExists = Boolean(col[0]);
    const fk = parentIdExists
      ? await prisma.$queryRawUnsafe<Array<{ constraint_name: string; delete_rule: string }>>(
          `SELECT tc.constraint_name, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.table_schema
           WHERE tc.table_schema='public'
             AND tc.table_name='Comment'
             AND tc.constraint_type='FOREIGN KEY'
             AND tc.constraint_name='Comment_parentId_fkey'`
        )
      : [];

    const counts = hasComment
      ? await prisma.$queryRawUnsafe<
          Array<{
            total: bigint;
            live: bigint;
            deleted: bigint;
            fingerprint: string;
          }>
        >(
          `SELECT COUNT(*)::bigint AS total,
                  COUNT(*) FILTER (WHERE "deletedAt" IS NULL)::bigint AS live,
                  COUNT(*) FILTER (WHERE "deletedAt" IS NOT NULL)::bigint AS deleted,
                  coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') AS fingerprint
           FROM "Comment"`
        )
      : [];

    let withParent: number | null = null;
    let nullParent: number | null = null;
    if (hasComment && parentIdExists) {
      const parentCounts = await prisma.$queryRawUnsafe<
        Array<{ with_parent: bigint; null_parent: bigint }>
      >(
        `SELECT COUNT(*) FILTER (WHERE "parentId" IS NOT NULL)::bigint AS with_parent,
                COUNT(*) FILTER (WHERE "parentId" IS NULL)::bigint AS null_parent
         FROM "Comment"`
      );
      withParent = Number(parentCounts[0]?.with_parent ?? 0);
      nullParent = Number(parentCounts[0]?.null_parent ?? 0);
    }

    const gate = hasPm
      ? gateSingleMigration({
          target: MIGRATION_NAME,
          repo,
          appliedFinished,
          failedNames,
          // inspect does not spawn prisma; repo/DB pending is the source of truth
          statusPending: appliedFinished.includes(MIGRATION_NAME)
            ? []
            : repo.filter((m) => !appliedFinished.includes(m)),
        })
      : {
          action: "hold" as const,
          reason: "_prisma_migrations missing",
          pendingFromRepo: repo,
          unexpectedPending: repo.filter((m) => m !== MIGRATION_NAME),
          unknownApplied: [] as string[],
        };

    console.log(
      JSON.stringify(
        {
          host,
          writes: false,
          migrationName: MIGRATION_NAME,
          migration: thisMig[0]
            ? {
                name: thisMig[0].migration_name,
                finished: Boolean(thisMig[0].finished_at && !thisMig[0].rolled_back_at),
              }
            : null,
          failedNames,
          gate: { action: gate.action, reason: gate.reason, pendingFromRepo: gate.pendingFromRepo },
          parentIdColumn: col[0] ?? null,
          parentFk: fk[0] ?? null,
          counts: counts[0]
            ? {
                total: Number(counts[0].total),
                live: Number(counts[0].live),
                deleted: Number(counts[0].deleted),
                withParent,
                nullParent,
                idFingerprint: counts[0].fingerprint,
              }
            : null,
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
