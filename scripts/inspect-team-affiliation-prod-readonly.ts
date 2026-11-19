/**
 * Production READ ONLY: team affiliation migration gate / tables / fingerprints.
 * WRITE 금지. migrate 금지. 캐디 이름·유저명·배치 payload 미출력.
 *
 *   npx tsx scripts/inspect-team-affiliation-prod-readonly.ts
 */
import { createRequire } from "node:module";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";
import {
  EXPECTED_BRANCH_ID,
  EXPECTED_DB,
  EXPECTED_ENDPOINT_ID,
  EXPECTED_FK,
  EXPECTED_HOST,
  EXPECTED_INDEXES,
  MIGRATION_NAME,
  ROOT,
  assertProductionEndpoint,
  localMigrationChecksum,
} from "./maintenance/teamAffiliationProd";

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
  const endpoint = assertProductionEndpoint(url);
  if (!endpoint.ok || host !== EXPECTED_HOST) {
    throw new Error(`unexpected host ${host}`);
  }

  const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));
  const localChecksum = localMigrationChecksum(MIGRATION_NAME);
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const ident = await prisma.$queryRawUnsafe<
      Array<{ database: string; endpoint: string; branch: string }>
    >(
      `SELECT current_database() AS database,
              coalesce(current_setting('neon.endpoint_id', true), 'n/a') AS endpoint,
              coalesce(current_setting('neon.branch_id', true), 'n/a') AS branch`
    );
    const database = ident[0]?.database ?? "";
    const neonEndpoint = ident[0]?.endpoint ?? "n/a";
    const neonBranch = ident[0]?.branch ?? "n/a";
    if (database !== EXPECTED_DB) throw new Error(`unexpected database ${database}`);
    if (neonEndpoint !== "n/a" && neonEndpoint !== EXPECTED_ENDPOINT_ID) {
      throw new Error(`unexpected neon.endpoint_id ${neonEndpoint}`);
    }
    if (neonBranch !== "n/a" && neonBranch !== EXPECTED_BRANCH_ID) {
      throw new Error(`unexpected neon.branch_id ${neonBranch}`);
    }

    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    const hasPm = tableNames.includes("_prisma_migrations");

    const applied = hasPm
      ? await prisma.$queryRawUnsafe<
          Array<{
            migration_name: string;
            checksum: string;
            finished_at: Date | null;
            rolled_back_at: Date | null;
          }>
        >(
          `SELECT migration_name, checksum, finished_at, rolled_back_at
           FROM "_prisma_migrations"
           ORDER BY started_at ASC NULLS LAST, migration_name ASC`
        )
      : [];
    const appliedFinished = applied
      .filter((r) => r.finished_at && !r.rolled_back_at)
      .map((r) => r.migration_name);
    const failedNames = [
      ...new Set(applied.filter((r) => !r.finished_at || r.rolled_back_at).map((r) => r.migration_name)),
    ];
    const thisMig = applied.filter((r) => r.migration_name === MIGRATION_NAME);
    const recordedChecksum = thisMig[0]?.checksum ?? null;

    const idxNames = EXPECTED_INDEXES.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (${idxNames})`
    );
    const fk = await prisma.$queryRawUnsafe<Array<{ constraint_name: string; delete_rule: string }>>(
      `SELECT tc.constraint_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
       WHERE tc.table_schema='public'
         AND tc.table_name='TeamAffiliationItem'
         AND tc.constraint_type='FOREIGN KEY'
         AND tc.constraint_name='${EXPECTED_FK}'`
    );

    const users = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
      `SELECT COUNT(*)::bigint AS total,
              coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') AS fingerprint
       FROM "User"`
    );
    const caddies = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
      `SELECT COUNT(*)::bigint AS total,
              coalesce(md5(string_agg(id::text || ':' || "employmentStatus"::text || ':' || team, ',' ORDER BY id)), 'empty') AS fingerprint
       FROM "Caddy"`
    );
    const boards = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
      `SELECT COUNT(*)::bigint AS total,
              coalesce(md5(string_agg(id::text || ':' || md5(payload::text), ',' ORDER BY id)), 'empty') AS fingerprint
       FROM "DailyBoardPublished"`
    );

    let versionRows: number | null = null;
    let itemRows: number | null = null;
    if (tableNames.includes("TeamAffiliationVersion")) {
      const v = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "TeamAffiliationVersion"`
      );
      versionRows = Number(v[0]?.n ?? 0);
    }
    if (tableNames.includes("TeamAffiliationItem")) {
      const i = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "TeamAffiliationItem"`
      );
      itemRows = Number(i[0]?.n ?? 0);
    }

    const gate = hasPm
      ? gateSingleMigration({
          target: MIGRATION_NAME,
          repo,
          appliedFinished,
          failedNames,
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
          database,
          neonEndpoint,
          neonBranch,
          writes: false,
          migrationName: MIGRATION_NAME,
          localChecksum,
          recordedChecksum,
          repoMigrations: repo.length,
          appliedFinished: appliedFinished.length,
          migration: thisMig[0]
            ? {
                name: thisMig[0].migration_name,
                finished: Boolean(thisMig[0].finished_at && !thisMig[0].rolled_back_at),
              }
            : null,
          failedNames,
          gate: { action: gate.action, reason: gate.reason, pendingFromRepo: gate.pendingFromRepo },
          tables: {
            TeamAffiliationVersion: tableNames.includes("TeamAffiliationVersion"),
            TeamAffiliationItem: tableNames.includes("TeamAffiliationItem"),
          },
          indexes: idx.map((r) => r.indexname),
          fk: fk[0] ?? null,
          versionRows,
          itemRows,
          users: { total: Number(users[0]?.total ?? 0), idFingerprint: users[0]?.fingerprint },
          caddies: { total: Number(caddies[0]?.total ?? 0), rosterFingerprint: caddies[0]?.fingerprint },
          publishedBoards: {
            total: Number(boards[0]?.total ?? 0),
            payloadFingerprint: boards[0]?.fingerprint,
          },
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
