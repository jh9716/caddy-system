/**
 * Production: 커뮤니티 자유게시판 V1 migration (20261120160000_community_free_board_v1) 전용.
 *
 * ⚠️ main 병합 금지 · 사용자 명시 승인 없이 실행 금지.
 *
 * 순서 (단계마다 별도 승인):
 *   1. precheck (읽기 전용, 모든 조회를 READ ONLY 트랜잭션 + prisma migrate status 로만):
 *        PROD_DB_MODE=precheck \
 *        PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_PRECHECK_20261121 \
 *        PROD_DB_CONFIRM="PROD-DB-PRECHECK morning-tooth-60659454 20261120160000_community_free_board_v1" \
 *        DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *        npx tsx scripts/maintenance/deploy-community-free-board-migration.ts
 *   2. Neon 콘솔: PITR 범위 확인 + 백업 브랜치 backup-pre-pr380-prod-YYYYMMDD 생성·LSN 기록 (이 스크립트는 만들지 않음)
 *   3. migrate (prisma migrate deploy 1회, 재시도 없음):
 *        PROD_DB_MODE=migrate \
 *        PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_MIGRATE_20261121 \
 *        PROD_DB_CONFIRM="PROD-DB-MIGRATE morning-tooth-60659454 20261120160000_community_free_board_v1" \
 *        NEON_PITR_WINDOW_CONFIRMED=YES NEON_BACKUP_BRANCH=backup-pre-pr380-prod-YYYYMMDD \
 *        DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *        npx tsx scripts/maintenance/deploy-community-free-board-migration.ts
 *
 * 금지: db push, migrate reset/dev/resolve, seed, 기존 행 INSERT/UPDATE/DELETE. 자동 재시도 없음.
 * 출력: 이름·개수·지문(md5)만. DATABASE_URL·비밀값은 출력하지 않는다.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { requireProdMaintenance } from "../requireProdMaintenance";
import {
  EXPECTED_HOST,
  EXPECTED_PROJECT_ID,
  ENUM_VALUE,
  FINGERPRINT_TABLES,
  MIGRATION_NAME,
  NEW_ENUM,
  NEW_TABLES,
  ROOT,
  SQL_REL,
  TASK_IDS,
  assertCommunityProdUrl,
  assertCommunitySchemaAfter,
  assertNeonIdentity,
  allowedPrismaArgs,
  assertPinnedTargetChecksum,
  auditCommunityMigrationSql,
  compareFingerprints,
  decideCommunityMigration,
  listsEqual,
  migrationChecksum,
  repoChecksums,
  resolveModeAndConfirm,
  summarizeMigrationRows,
  type AppliedRow,
  type Fingerprint,
  type GateFn,
  type NeonIdentity,
  type SchemaProbe,
} from "./communityFreeBoardProd";

const requireCjs = createRequire(__filename);
const { listRepoMigrations } = requireCjs("../preview-db/migration-state.cjs") as {
  listRepoMigrations: (dir: string) => string[];
};
const { parsePrismaMigrateStatusPending, gateSingleMigration } = requireCjs("./single-migration-gate.cjs") as {
  parsePrismaMigrateStatusPending: (out: string) => string[];
  gateSingleMigration: GateFn;
};

const URL_RE = /postgres(ql)?:\/\/[^\s"']+/gi;
const redact = (s: string) => s.replace(URL_RE, "<url>");

function runPrisma(url: string, args: string[]): string {
  if (!allowedPrismaArgs(args)) throw new Error(`HOLD: refusing prisma ${args.join(" ")}`);
  const bin = path.join(ROOT, "node_modules", ".bin", "prisma");
  const r = spawnSync(bin, args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1", CHECKPOINT_DISABLE: "1" },
    encoding: "utf8",
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  process.stderr.write(redact(out));
  if (r.status !== 0 && args[1] === "deploy") {
    throw new Error("HOLD: prisma migrate deploy failed (no retry). See output above.");
  }
  return out;
}

type Db = PrismaClient | Prisma.TransactionClient;

async function readMigrationRows(db: Db): Promise<AppliedRow[]> {
  return db.$queryRawUnsafe<AppliedRow[]>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
     FROM "_prisma_migrations"
     ORDER BY started_at ASC NULLS LAST, migration_name ASC`
  );
}

async function neonIdentity(db: Db): Promise<NeonIdentity> {
  const rows = await db.$queryRawUnsafe<NeonIdentity[]>(
    `SELECT current_database() AS database,
            coalesce(current_setting('neon.endpoint_id', true), 'n/a') AS endpoint,
            coalesce(current_setting('neon.branch_id', true), 'n/a') AS branch`
  );
  return rows[0];
}

async function publicTables(db: Db): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'`
  );
  return rows.map((r) => r.table_name);
}

async function probeSchema(db: Db): Promise<SchemaProbe> {
  const tables = await publicTables(db);
  const enumType = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*)::bigint AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace
     WHERE ns.nspname='public' AND t.typname='${NEW_ENUM}'`
  );
  const enumValue = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*)::bigint AS n FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
     JOIN pg_namespace ns ON ns.oid=t.typnamespace
     WHERE ns.nspname='public' AND t.typname='${ENUM_VALUE.type}' AND e.enumlabel='${ENUM_VALUE.value}'`
  );
  const idx = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('CommunityPost','CommunityPhoto')`
  );
  const fk = await db.$queryRawUnsafe<Array<{ constraint_name: string; delete_rule: string }>>(
    `SELECT tc.constraint_name, rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
     WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
       AND tc.table_name IN ('CommunityPost','CommunityPhoto')`
  );
  const rowCounts: Record<string, number> = {};
  for (const t of NEW_TABLES) {
    if (tables.includes(t)) {
      const c = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${t}"`);
      rowCounts[t] = Number(c[0]?.n ?? -1);
    }
  }
  return {
    tables,
    enumTypeExists: Number(enumType[0]?.n ?? 0) > 0,
    enumValueExists: Number(enumValue[0]?.n ?? 0) > 0,
    indexes: idx.map((r) => r.indexname),
    fks: Object.fromEntries(fk.map((r) => [r.constraint_name, r.delete_rule])),
    rowCounts,
  };
}

/** 지문 대상 컬럼 (재분류·삭제 감지). 테이블 이름은 고정 목록에서만 온다. */
const FINGERPRINT_EXPR: Record<(typeof FINGERPRINT_TABLES)[number], string> = {
  User: `id::text`,
  Caddy: `id::text || ':' || "employmentStatus"::text || ':' || team`,
  DailyBoardPublished: `id::text || ':' || md5(payload::text)`,
  FreeBoardPost: `id::text`,
  FreeBoardPhoto: `id::text || ':' || "postId"::text`,
  CommentThread: `id::text || ':' || "targetType"::text || ':' || "targetKey"`,
  Comment: `id::text || ':' || "threadId"::text`,
};

async function maxIds(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of FINGERPRINT_TABLES) {
    const r = await db.$queryRawUnsafe<Array<{ m: number | null }>>(`SELECT max(id) AS m FROM "${t}"`);
    out[t] = Number(r[0]?.m ?? 0);
  }
  return out;
}

/** 실행 전에 있던 행(id ≤ maxId)만 대상으로 개수·지문. 운영 중 새 행이 생겨도 오탐하지 않음. */
async function fingerprints(db: Db, maxId: Record<string, number>): Promise<Record<string, Fingerprint>> {
  const out: Record<string, Fingerprint> = {};
  for (const t of FINGERPRINT_TABLES) {
    const r = await db.$queryRawUnsafe<Array<{ total: bigint; fingerprint: string }>>(
      `SELECT COUNT(*)::bigint AS total,
              coalesce(md5(string_agg(${FINGERPRINT_EXPR[t]}, ',' ORDER BY id)), 'empty') AS fingerprint
       FROM "${t}" WHERE id <= $1`,
      maxId[t]
    );
    out[t] = { total: Number(r[0]?.total ?? -1), fingerprint: r[0]?.fingerprint ?? "missing" };
  }
  return out;
}

type Snapshot = {
  ident: NeonIdentity;
  tables: string[];
  rows: AppliedRow[];
  probe: SchemaProbe;
  maxId: Record<string, number>;
  prints: Record<string, Fingerprint>;
};

/** 모든 조회를 READ ONLY 트랜잭션 안에서. */
async function readOnlySnapshot(prisma: PrismaClient, maxIdFixed?: Record<string, number>): Promise<Snapshot> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const ident = await neonIdentity(tx);
      const tables = await publicTables(tx);
      const rows = tables.includes("_prisma_migrations") ? await readMigrationRows(tx) : [];
      const probe = await probeSchema(tx);
      const required = ["_prisma_migrations", ...FINGERPRINT_TABLES];
      const missing = required.filter((t) => !tables.includes(t));
      if (missing.length) throw new Error(`HOLD: expected tables missing ${JSON.stringify(missing)}`);
      const maxId = maxIdFixed ?? (await maxIds(tx));
      const prints = await fingerprints(tx, maxId);
      return { ident, tables, rows, probe, maxId, prints };
    },
    { timeout: 60_000 }
  );
}

async function main() {
  // 1) DB 연결 전: 모드·확인 문구·URL·SQL·checksum
  const mode = resolveModeAndConfirm(process.env);
  const { url, host } = requireProdMaintenance(TASK_IDS[mode]);
  assertCommunityProdUrl(url);
  if (host !== EXPECTED_HOST) throw new Error("HOLD: unexpected production host");

  const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");
  auditCommunityMigrationSql(sql);
  const sum1 = migrationChecksum(ROOT, MIGRATION_NAME);
  assertPinnedTargetChecksum(sum1);
  const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));
  const repoSums = repoChecksums(ROOT, repo);

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    // 2) 읽기 전용 점검 2회 (사이에 상태가 바뀌면 차단)
    const s1 = await readOnlySnapshot(prisma);
    assertNeonIdentity(s1.ident);
    const st1 = parsePrismaMigrateStatusPending(runPrisma(url, ["migrate", "status"]));
    const d1 = decideCommunityMigration({
      gate: gateSingleMigration,
      repo,
      repoSums,
      state: summarizeMigrationRows(s1.rows),
      statusPending: st1,
      probe: s1.probe,
    });

    const s2 = await readOnlySnapshot(prisma, s1.maxId);
    assertNeonIdentity(s2.ident);
    const st2 = parsePrismaMigrateStatusPending(runPrisma(url, ["migrate", "status"]));
    const d2 = decideCommunityMigration({
      gate: gateSingleMigration,
      repo,
      repoSums: repoChecksums(ROOT, repo),
      state: summarizeMigrationRows(s2.rows),
      statusPending: st2,
      probe: s2.probe,
    });
    const sum2 = migrationChecksum(ROOT, MIGRATION_NAME);
    if (sum1 !== sum2) throw new Error("HOLD: local migration.sql changed between reads");
    if (
      d1.action !== d2.action ||
      d1.reason !== d2.reason ||
      !listsEqual(st1, st2) ||
      !listsEqual(summarizeMigrationRows(s1.rows).appliedFinished, summarizeMigrationRows(s2.rows).appliedFinished)
    ) {
      throw new Error("HOLD: migration state changed between checks");
    }

    const report = {
      mode,
      project: EXPECTED_PROJECT_ID,
      host,
      database: s2.ident.database,
      neonEndpoint: s2.ident.endpoint,
      neonBranch: s2.ident.branch,
      migration: MIGRATION_NAME,
      localChecksum: sum2,
      repoMigrations: repo.length,
      appliedFinished: summarizeMigrationRows(s2.rows).appliedFinished.length,
      statusPending: st2,
      decision: d2,
      fingerprintsBefore: s2.prints,
      backupBranch: mode === "migrate" ? process.env.NEON_BACKUP_BRANCH : undefined,
    };

    if (d2.action === "hold") {
      console.log(JSON.stringify({ ok: false, ...report }, null, 2));
      throw new Error(`HOLD: ${d2.reason}`);
    }
    if (d2.action === "already-applied") {
      assertCommunitySchemaAfter(s2.probe, { requireEmpty: false });
      console.log(JSON.stringify({ ok: true, alreadyApplied: true, ...report }, null, 2));
      console.error("OK: already applied; nothing to do (no deploy)");
      return;
    }
    if (mode === "precheck") {
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
      console.error("OK: precheck passed (read-only). migrate requires a separate approval and mode.");
      return;
    }

    // 3) migrate: prisma migrate deploy 1회 (재시도 없음)
    console.log(JSON.stringify({ ok: true, phase: "pre-deploy", ...report }, null, 2));
    console.error("=== prisma migrate deploy (single run, no retry) ===");
    runPrisma(url, ["migrate", "deploy"]);

    // 4) 사후 검증 (읽기 전용)
    const s3 = await readOnlySnapshot(prisma, s2.maxId);
    assertNeonIdentity(s3.ident);
    assertCommunitySchemaAfter(s3.probe, { requireEmpty: true });
    const changed = compareFingerprints(s2.prints, s3.prints);
    if (changed.length) throw new Error(`HOLD: existing rows changed in ${JSON.stringify(changed)} — investigate`);
    const after = summarizeMigrationRows(s3.rows);
    if (!after.appliedFinished.includes(MIGRATION_NAME)) throw new Error("HOLD: target not recorded as finished");
    if (after.failedNames.length) throw new Error(`HOLD: failed migrations after deploy ${JSON.stringify(after.failedNames)}`);
    if (after.checksumByName[MIGRATION_NAME] !== sum2) throw new Error("HOLD: recorded checksum != local migration.sql");
    const stAfter = parsePrismaMigrateStatusPending(runPrisma(url, ["migrate", "status"]));
    if (stAfter.length) throw new Error(`HOLD: pending after deploy ${JSON.stringify(stAfter)}`);

    console.log(
      JSON.stringify(
        { ok: true, mode: "deployed", migration: MIGRATION_NAME, fingerprintsAfter: s3.prints, unchanged: true },
        null,
        2
      )
    );
    console.error("OK: community free board migration applied (additive, empty tables)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
