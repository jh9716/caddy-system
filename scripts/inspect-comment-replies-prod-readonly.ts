/**
 * Production READ ONLY: Comment.parentId column / FK / null counts.
 * WRITE 금지. migrate 금지.
 *
 *   npx tsx scripts/inspect-comment-replies-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const MIGRATION_NAME = "20261109193000_comment_replies_v1";

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
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const mig = await prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
      `SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const col = await prisma.$queryRawUnsafe<
      Array<{ column_name: string; udt_name: string; is_nullable: string }>
    >(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'`
    );
    const fk = await prisma.$queryRawUnsafe<
      Array<{ constraint_name: string; delete_rule: string }>
    >(
      `SELECT tc.constraint_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
       WHERE tc.table_name='Comment' AND tc.constraint_type='FOREIGN KEY'
         AND tc.constraint_name='Comment_parentId_fkey'`
    );
    const counts = await prisma.$queryRawUnsafe<
      Array<{ total: bigint; live: bigint; deleted: bigint; with_parent: bigint; null_parent: bigint }>
    >(
      `SELECT COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE "deletedAt" IS NULL)::bigint AS live,
              COUNT(*) FILTER (WHERE "deletedAt" IS NOT NULL)::bigint AS deleted,
              COUNT(*) FILTER (WHERE "parentId" IS NOT NULL)::bigint AS with_parent,
              COUNT(*) FILTER (WHERE "parentId" IS NULL)::bigint AS null_parent
       FROM "Comment"`
    );
    console.log(
      JSON.stringify(
        {
          host,
          migration: mig[0] ?? null,
          parentIdColumn: col[0] ?? null,
          parentFk: fk[0] ?? null,
          counts: counts[0]
            ? {
                total: Number(counts[0].total),
                live: Number(counts[0].live),
                deleted: Number(counts[0].deleted),
                withParent: Number(counts[0].with_parent),
                nullParent: Number(counts[0].null_parent),
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
