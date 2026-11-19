/**
 * Production: apply additive team affiliation settings migration only.
 *
 * Deploy order (required):
 *   1. Preview DB migrate deploy (separate approval) and verify.
 *   2. Neon console PITR window confirmed for morning-tooth-60659454.
 *   3. This script on production (explicit confirm + PITR flag).
 *   4. App release that uses TeamAffiliation tables may already be on Preview;
 *      Production app falls back until this migrate finishes.
 *
 *   PROD_MAINTENANCE_CONFIRM=TEAM_AFFILIATION_SETTINGS_20261117 \
 *   NEON_PITR_WINDOW_CONFIRMED=YES \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/maintenance/deploy-team-affiliation-migration.ts
 *
 * READ-ONLY inspect first (DB _prisma_migrations + prisma migrate status + checksums).
 * `prisma migrate deploy` runs only when the sole pending migration is
 * 20261117233000_team_affiliation_settings. Extra pending/failed/unknown abort.
 * Gate and checksums are re-read immediately before deploy.
 *
 * Forbidden: db push, migrate reset, migrate dev, seed, Caddy/User/DailyBoardPublished writes.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";
import {
  EXPECTED_BRANCH_ID,
  EXPECTED_DB,
  EXPECTED_ENDPOINT_ID,
  EXPECTED_FK,
  EXPECTED_HOST,
  EXPECTED_INDEXES,
  EXPECTED_PROJECT_ID,
  MIGRATION_NAME,
  ROOT,
  SQL_REL,
  TASK_ID,
  assertEmptyAffiliationRows,
  assertPitrConfirmed,
  assertProductionEndpoint,
  assertTeamAffiliationSchema,
  auditTeamAffiliationMigrationSql,
  listsEqual,
  localMigrationChecksum,
  type SchemaProbe,
} from "./teamAffiliationProd";

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

type Fingerprint = { total: number; fingerprint: string };

async function idFingerprint(prisma: PrismaClient, table: string): Promise<Fingerprint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
    `SELECT COUNT(*)::bigint AS total,
            coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') AS fingerprint
     FROM "${table}"`
  );
  return {
    total: Number(rows[0]?.total ?? -1),
    fingerprint: rows[0]?.fingerprint ?? "missing",
  };
}

async function caddyRosterFingerprint(prisma: PrismaClient): Promise<Fingerprint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
    `SELECT COUNT(*)::bigint AS total,
            coalesce(md5(string_agg(id::text || ':' || "employmentStatus"::text || ':' || team, ',' ORDER BY id)), 'empty') AS fingerprint
     FROM "Caddy"`
  );
  return {
    total: Number(rows[0]?.total ?? -1),
    fingerprint: rows[0]?.fingerprint ?? "missing",
  };
}

async function publishedBoardFingerprint(prisma: PrismaClient): Promise<Fingerprint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
    `SELECT COUNT(*)::bigint AS total,
            coalesce(md5(string_agg(id::text || ':' || md5(payload::text), ',' ORDER BY id)), 'empty') AS fingerprint
     FROM "DailyBoardPublished"`
  );
  return {
    total: Number(rows[0]?.total ?? -1),
    fingerprint: rows[0]?.fingerprint ?? "missing",
  };
}

async function readMigrationState(prisma: PrismaClient) {
  const applied = await prisma.$queryRawUnsafe<
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
  );
  const appliedFinished = applied
    .filter((r) => r.finished_at && !r.rolled_back_at)
    .map((r) => r.migration_name);
  const failedNames = [
    ...new Set(
      applied.filter((r) => !r.finished_at || r.rolled_back_at).map((r) => r.migration_name)
    ),
  ];
  const checksumByName = Object.fromEntries(
    applied.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => [r.migration_name, r.checksum])
  ) as Record<string, string>;
  return { appliedFinished, failedNames, checksumByName };
}

async function neonIdentity(prisma: PrismaClient) {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ database: string; endpoint: string; branch: string; read_only: string }>
  >(
    `SELECT current_database() AS database,
            coalesce(current_setting('neon.endpoint_id', true), 'n/a') AS endpoint,
            coalesce(current_setting('neon.branch_id', true), 'n/a') AS branch,
            current_setting('transaction_read_only') AS read_only`
  );
  return rows[0];
}

async function describeAffiliation(prisma: PrismaClient): Promise<SchemaProbe> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'
       AND table_name IN ('TeamAffiliationVersion', 'TeamAffiliationItem')`
  );
  const names = new Set(tables.map((t) => t.table_name));
  const versionTable = names.has("TeamAffiliationVersion");
  const itemTable = names.has("TeamAffiliationItem");
  const idxNames = EXPECTED_INDEXES.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
  const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname='public'
       AND indexname IN (${idxNames})`
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
  let versionRows = 0;
  let itemRows = 0;
  if (versionTable) {
    const v = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "TeamAffiliationVersion"`
    );
    versionRows = Number(v[0]?.n ?? -1);
  }
  if (itemTable) {
    const i = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "TeamAffiliationItem"`
    );
    itemRows = Number(i[0]?.n ?? -1);
  }
  return {
    versionTable,
    itemTable,
    indexes: idx.map((r) => r.indexname),
    fk: fk[0] ? { name: fk[0].constraint_name, deleteRule: fk[0].delete_rule } : null,
    versionRows,
    itemRows,
  };
}

function assertUnchanged(label: string, before: Fingerprint, after: Fingerprint): void {
  if (after.total !== before.total) {
    throw new Error(`HOLD: ${label} row count changed ${before.total} → ${after.total}`);
  }
  if (after.fingerprint !== before.fingerprint) {
    throw new Error(`HOLD: ${label} fingerprint changed; existing rows were modified`);
  }
}

async function main() {
  const { url, host } = requireProdMaintenance(TASK_ID);
  const endpoint = assertProductionEndpoint(url);
  if (!endpoint.ok) {
    throw new Error(`HOLD: unexpected production endpoint (${endpoint.reason}) host=${host}`);
  }
  if (host !== EXPECTED_HOST) {
    throw new Error(`HOLD: unexpected production host ${host}`);
  }
  assertPitrConfirmed();

  const sqlPath = path.join(ROOT, SQL_REL);
  const sql = fs.readFileSync(sqlPath, "utf8");
  auditTeamAffiliationMigrationSql(sql);
  const checksumFirst = localMigrationChecksum(MIGRATION_NAME);
  const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const ident = await neonIdentity(prisma);
    if (ident.database !== EXPECTED_DB) {
      throw new Error(`HOLD: current_database is ${ident.database}, expected ${EXPECTED_DB}`);
    }
    if (ident.endpoint !== "n/a" && ident.endpoint !== EXPECTED_ENDPOINT_ID) {
      throw new Error(`HOLD: neon.endpoint_id ${ident.endpoint} is not Production`);
    }
    if (ident.branch !== "n/a" && ident.branch !== EXPECTED_BRANCH_ID) {
      throw new Error(`HOLD: neon.branch_id ${ident.branch} is not ${EXPECTED_BRANCH_ID}`);
    }

    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const tableNames = tables.map((t) => t.table_name);
    if (!tableNames.includes("_prisma_migrations")) {
      throw new Error("HOLD: _prisma_migrations missing; refusing unexpected schema");
    }
    if (!tableNames.includes("Caddy") || !tableNames.includes("User")) {
      throw new Error("HOLD: Caddy/User missing; refusing unexpected schema");
    }
    if (!tableNames.includes("DailyBoardPublished")) {
      throw new Error("HOLD: DailyBoardPublished missing; refusing unexpected schema");
    }

    const state1 = await readMigrationState(prisma);
    const usersBefore = await idFingerprint(prisma, "User");
    const caddiesBefore = await caddyRosterFingerprint(prisma);
    const boardsBefore = await publishedBoardFingerprint(prisma);
    const schemaBefore = await describeAffiliation(prisma);
    console.error("users before:", usersBefore.total);
    console.error("caddies before:", caddiesBefore.total);
    console.error("published boards before:", boardsBefore.total);

    const statusOut = runPrisma(url, ["migrate", "status"]);
    const statusPending = parsePrismaMigrateStatusPending(statusOut);
    const gate1 = gateSingleMigration({
      target: MIGRATION_NAME,
      repo,
      appliedFinished: state1.appliedFinished,
      failedNames: state1.failedNames,
      statusPending,
    });

    const checksumSecond = localMigrationChecksum(MIGRATION_NAME);
    if (checksumFirst !== checksumSecond) {
      throw new Error("HOLD: local migration.sql checksum changed between reads");
    }

    const state2 = await readMigrationState(prisma);
    const statusOut2 = runPrisma(url, ["migrate", "status"]);
    const statusPending2 = parsePrismaMigrateStatusPending(statusOut2);
    const gate2 = gateSingleMigration({
      target: MIGRATION_NAME,
      repo,
      appliedFinished: state2.appliedFinished,
      failedNames: state2.failedNames,
      statusPending: statusPending2,
    });
    if (
      gate1.action !== gate2.action ||
      gate1.reason !== gate2.reason ||
      !listsEqual(gate1.pendingFromRepo, gate2.pendingFromRepo) ||
      !listsEqual(state1.appliedFinished, state2.appliedFinished)
    ) {
      throw new Error("HOLD: migration list changed between checks");
    }

    const inspect = {
      host,
      database: ident.database,
      neonEndpoint: ident.endpoint,
      neonBranch: ident.branch,
      project: EXPECTED_PROJECT_ID,
      migration: MIGRATION_NAME,
      localChecksum: checksumSecond,
      gate: gate2.action,
      reason: gate2.reason,
      pendingFromRepo: gate2.pendingFromRepo,
      unexpectedPending: gate2.unexpectedPending,
      unknownApplied: gate2.unknownApplied,
      failedNames: state2.failedNames,
      statusPending: statusPending2,
      users: usersBefore,
      caddies: { total: caddiesBefore.total, rosterFingerprint: caddiesBefore.fingerprint },
      publishedBoards: boardsBefore,
      affiliationBefore: schemaBefore,
    };

    if (gate2.action === "hold") {
      console.log(JSON.stringify({ ok: false, ...inspect }, null, 2));
      throw new Error(`HOLD: ${gate2.reason}`);
    }

    if (gate2.action === "already-applied") {
      assertTeamAffiliationSchema(schemaBefore);
      assertEmptyAffiliationRows(schemaBefore);
      const recorded = state2.checksumByName[MIGRATION_NAME];
      if (recorded && recorded !== checksumSecond) {
        throw new Error("HOLD: recorded checksum does not match local migration.sql");
      }
      console.log(JSON.stringify({ ok: true, mode: "already-applied", ...inspect }, null, 2));
      console.error("OK: team affiliation migration already applied; no deploy");
      return;
    }

    if (schemaBefore.versionTable || schemaBefore.itemTable) {
      console.log(
        JSON.stringify(
          { ok: false, hold: "affiliation tables exist but migration not recorded", ...inspect },
          null,
          2
        )
      );
      throw new Error("HOLD: affiliation tables exist but migration is not recorded");
    }

    console.log(JSON.stringify({ ok: true, mode: "pre-deploy", ...inspect }, null, 2));
    console.error("=== prisma migrate deploy ===");
    runPrisma(url, ["migrate", "deploy"]);

    const usersAfter = await idFingerprint(prisma, "User");
    const caddiesAfter = await caddyRosterFingerprint(prisma);
    const boardsAfter = await publishedBoardFingerprint(prisma);
    assertUnchanged("User", usersBefore, usersAfter);
    assertUnchanged("Caddy roster", caddiesBefore, caddiesAfter);
    assertUnchanged("DailyBoardPublished", boardsBefore, boardsAfter);

    const schemaAfter = await describeAffiliation(prisma);
    assertTeamAffiliationSchema(schemaAfter);
    assertEmptyAffiliationRows(schemaAfter);

    const statusAfter = runPrisma(url, ["migrate", "status"]);
    const pendingAfter = parsePrismaMigrateStatusPending(statusAfter);
    if (pendingAfter.length !== 0 && !/Database schema is up to date/i.test(statusAfter)) {
      throw new Error(`HOLD: pending after deploy ${JSON.stringify(pendingAfter)}`);
    }
    const afterState = await readMigrationState(prisma);
    if (!afterState.appliedFinished.includes(MIGRATION_NAME)) {
      throw new Error("HOLD: migration not recorded as finished in _prisma_migrations");
    }
    if (afterState.failedNames.length > 0) {
      throw new Error(`HOLD: failed migrations after deploy ${JSON.stringify(afterState.failedNames)}`);
    }
    const recorded = afterState.checksumByName[MIGRATION_NAME];
    if (recorded !== checksumSecond) {
      throw new Error("HOLD: deployed checksum does not match local migration.sql");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "deployed",
          host,
          users: usersAfter,
          caddies: { total: caddiesAfter.total, rosterFingerprint: caddiesAfter.fingerprint },
          publishedBoards: boardsAfter,
          countsUnchanged: true,
          affiliation: schemaAfter,
          pendingAfter,
          recordedChecksum: recorded,
        },
        null,
        2
      )
    );
    console.error("OK: team affiliation migration applied (additive empty tables)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
