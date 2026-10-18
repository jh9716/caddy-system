/**
 * Marshal P1–P3 production maintenance (Prisma 5.22 migrate deploy).
 *
 * Default mode is READ-ONLY inspect. Writes need an exact confirm token.
 * Checksum sync, migrate deploy, and Neon PITR are separate approval steps.
 *
 * Forbidden: psql -f, prisma db execute, prisma migrate resolve,
 * db push, migrate reset, migrate dev, ALLOW_PROD_DB, production writes
 * from this process without PROD_MAINTENANCE_CONFIRM.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  isLocalDatabaseUrl,
  isProductionDatabaseUrl,
  parseDatabaseUrl,
} from "../../src/lib/dbSafety";

export const ROOT = path.resolve(__dirname, "../..");
export const P4_HEAD_SHA = "5eb43469ccf9a241a5b69b6d84abd75e563b609d";
export const EXPECTED_PROD_HOST =
  "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
export const EXPECTED_PRISMA_SERIES = "5.22";
export const EXPECTED_ENGINES_HASH =
  "605197351a3c8bdd595af2d2a9bc3025bca48ea2";
export const APPLIED_BEFORE = 53;
export const APPLIED_AFTER = 60;
export const PROD_ACTIVE_MARSHALS = 30;

export const TASK = {
  applyProd: "MARSHAL_P1P3_MIGRATE_20261018",
  applyLocal: "MARSHAL_P1P3_MIGRATE_LOCAL",
  checksumProd: "MARSHAL_P1P3_CHECKSUM_SYNC_20261018",
  checksumLocal: "MARSHAL_P1P3_CHECKSUM_SYNC_LOCAL",
  freeze: "HELD",
  pitr: "YES",
} as const;

export const PENDING_NAMES = [
  "20261018120000_marshal_penalty_full_day_p1",
  "20261018133000_marshal_penalty_coverage_no_silent_default",
  "20261018140000_marshal_penalty_coverage_insert_fill",
  "20261018180000_marshal_penalty_occurrence_p2",
  "20261018190000_marshal_penalty_occurrence_integrity",
  "20261018200000_marshal_penalty_occurrence_pinned_on",
  "20261018210000_marshal_penalty_occurrence_auto_held_on",
] as const;

export const P1_FREEZE_UNTIL = PENDING_NAMES.slice(0, 3);

export const RECONSTRUCTED_NAMES = [
  "20260809101500_caddy_roster_fields",
  "20260809220000_add_caddy_type",
] as const;

/** Last known production checksums for reconstructed files (policy sync only). */
export const EXPECTED_PROD_RECONSTRUCTED_CHECKSUMS: Record<
  (typeof RECONSTRUCTED_NAMES)[number],
  string
> = {
  "20260809101500_caddy_roster_fields":
    "e189b2ca004bb537cfe0316b3076d8f62159023995c3b4445d6c01ff0cfa6c4f",
  "20260809220000_add_caddy_type":
    "fad270d680245d2a099482d2e9af98b0f09b4d6c2faeaf1a8284eb0ea503c7cb",
};

export type MaintMode = "inspect" | "apply" | "sync-checksums";

export type HoldError = Error & { hold: true; report?: unknown };

function hold(message: string, report?: unknown): never {
  const err = new Error(message) as HoldError;
  err.hold = true;
  err.report = report;
  throw err;
}

export function parseMaintMode(argv: string[]): MaintMode {
  const apply = argv.includes("--apply");
  const sync = argv.includes("--sync-checksums");
  const inspect = argv.includes("--inspect") || argv.includes("--inspect-only");
  const flagged = [apply, sync, inspect].filter(Boolean).length;
  if (flagged > 1) {
    hold("HOLD: --inspect, --apply, --sync-checksums are mutually exclusive");
  }
  if (apply) return "apply";
  if (sync) return "sync-checksums";
  return "inspect";
}

export function maskHost(host: string): string {
  const parts = host.split(".");
  if (parts.length < 3) {
    return host.length <= 4 ? host : `${host.slice(0, 4)}…`;
  }
  const first = parts[0] || "";
  const masked =
    first.length > 8 ? `${first.slice(0, 4)}…${first.slice(-2)}` : first;
  return [masked, ...parts.slice(1)].join(".");
}

export function sha256Bytes(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function migrationSqlPath(name: string): string {
  return path.join(ROOT, "prisma", "migrations", name, "migration.sql");
}

export function readMigrationSql(name: string): string {
  return fs.readFileSync(migrationSqlPath(name), "utf8");
}

export function gitChecksumFor(name: string): string {
  return sha256Bytes(fs.readFileSync(migrationSqlPath(name)));
}

const GLOBAL_FORBIDDEN = [
  /\bTRUNCATE\b/,
  /\bMIGRATE\s+RESET\b/,
  /\bDB\s+PUSH\b/,
  /\bDROP\s+TABLE\b/,
  /\bDROP\s+TYPE\b/,
  /\bDROP\s+DATABASE\b/,
  /\bDELETE\s+FROM\b/,
];

export function auditPendingSql(): string[] {
  const notes: string[] = [];
  for (const name of PENDING_NAMES) {
    const sql = readMigrationSql(name);
    const upper = stripSqlComments(sql).toUpperCase();
    for (const re of GLOBAL_FORBIDDEN) {
      if (re.test(upper)) hold(`HOLD: ${name} contains forbidden token ${re}`);
    }
    if (/\bPRISMA\s+DB\s+EXECUTE\b/.test(upper) || /\bPSQL\b/.test(upper)) {
      hold(`HOLD: ${name} must not invoke psql / db execute`);
    }
  }

  const p1 = stripSqlComments(readMigrationSql(PENDING_NAMES[0])).toUpperCase();
  if (!/CREATE\s+TYPE\s+"MARSHALPENALTYCOVERAGE"/.test(p1)) {
    hold("HOLD: P1 file 1 missing MarshalPenaltyCoverage enum");
  }
  if (!/DROP\s+INDEX\s+"MARSHALMONTHSLOT_PLANID_DATE_CADDYID_KEY"/.test(p1)) {
    hold("HOLD: P1 file 1 missing old slot unique drop");
  }
  if (
    !/CREATE\s+UNIQUE\s+INDEX\s+"MARSHALMONTHSLOT_PLANID_DATE_SHIFT_CADDYID_KEY"/.test(
      p1
    )
  ) {
    hold("HOLD: P1 file 1 missing shift+caddy unique");
  }
  if (!/ADD\s+COLUMN\s+"COVERAGE"/.test(p1)) {
    hold("HOLD: P1 file 1 missing coverage column");
  }
  if (!/UPDATE\s+"MARSHALPENALTYDUTY"/.test(p1)) {
    hold("HOLD: P1 file 1 missing coverage backfill UPDATE");
  }

  const p1b = stripSqlComments(readMigrationSql(PENDING_NAMES[1])).toUpperCase();
  if (!/ALTER\s+COLUMN\s+"COVERAGE"\s+DROP\s+DEFAULT/.test(p1b)) {
    hold("HOLD: P1 file 2 must DROP DEFAULT on coverage");
  }

  const p1c = stripSqlComments(readMigrationSql(PENDING_NAMES[2])).toUpperCase();
  if (!/MARSHAL_PENALTY_FILL_COVERAGE/.test(p1c)) {
    hold("HOLD: P1 file 3 missing coverage fill trigger/function");
  }

  const p2 = stripSqlComments(readMigrationSql(PENDING_NAMES[3])).toUpperCase();
  if (!/CREATE\s+TABLE\s+"MARSHALPENALTYOCCURRENCE"/.test(p2)) {
    hold("HOLD: P2 missing MarshalPenaltyOccurrence table");
  }

  const p2b = stripSqlComments(readMigrationSql(PENDING_NAMES[4])).toUpperCase();
  if (!/ADD\s+COLUMN\s+"NEEDSREGENERATION"/.test(p2b)) {
    hold("HOLD: P2 integrity missing needsRegeneration");
  }
  if (!/"IDEMPOTENCYKEY"/.test(p2b)) {
    hold("HOLD: P2 integrity missing idempotencyKey");
  }

  const p3a = stripSqlComments(readMigrationSql(PENDING_NAMES[5])).toUpperCase();
  if (!/ADD\s+COLUMN\s+"PINNEDON"/.test(p3a)) {
    hold("HOLD: P3 missing pinnedOn");
  }

  const p3b = stripSqlComments(readMigrationSql(PENDING_NAMES[6])).toUpperCase();
  if (!/ADD\s+COLUMN\s+"AUTOHELDON"/.test(p3b)) {
    hold("HOLD: P3 missing autoHeldOn");
  }
  if (!/UPDATE\s+"MARSHALPENALTYOCCURRENCE"/.test(p3b)) {
    hold("HOLD: P3 autoHeldOn missing backfill UPDATE");
  }

  notes.push("SQL audit PASS for 7 pending P1–P3 files");
  return notes;
}

export function parsePrismaVersion(out: string): {
  cli: string | null;
  client: string | null;
  enginesHash: string | null;
} {
  const cli = out.match(/^\s*prisma\s*:\s*([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1] ?? null;
  const client =
    out.match(/^\s*@prisma\/client\s*:\s*([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1] ?? null;
  const enginesHash =
    out.match(/Default Engines Hash\s*:\s*([a-f0-9]{40})/i)?.[1] ??
    out.match(/libquery-engine\s+([a-f0-9]{40})/i)?.[1] ??
    null;
  return { cli, client, enginesHash };
}

export function prismaSeriesOk(version: string | null): boolean {
  if (!version) return false;
  return version.startsWith(`${EXPECTED_PRISMA_SERIES}.`);
}

export function prismaBinPath(env: NodeJS.ProcessEnv, isProd: boolean): string {
  const override = env.MARSHAL_MAINT_PRISMA_BIN;
  if (override) {
    if (isProd) hold("HOLD: MARSHAL_MAINT_PRISMA_BIN is forbidden on production");
    return override;
  }
  return path.join(ROOT, "node_modules", ".bin", "prisma");
}

function prismaChildEnv(env: NodeJS.ProcessEnv, databaseUrl: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, DATABASE_URL: databaseUrl };
  delete child.NODE_OPTIONS;
  return child;
}

export function assertAllowedPrismaArgs(args: string[], allowDeploy: boolean): void {
  if (args.length === 1 && args[0] === "--version") return;
  if (args[0] === "migrate" && args[1] === "status" && args.length === 2) return;
  if (args[0] === "migrate" && args[1] === "deploy") {
    if (!allowDeploy) hold("HOLD: inspect/sync refuses prisma migrate deploy");
    if (args.length !== 2) hold("HOLD: prisma migrate deploy must have no extra flags");
    return;
  }
  hold(`HOLD: refusing prisma ${args.join(" ")}`);
}

export function runPrisma(
  args: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    databaseUrl: string;
    isProd: boolean;
    allowDeploy: boolean;
  }
): { status: number | null; out: string } {
  assertAllowedPrismaArgs(args, opts.allowDeploy);
  const bin = prismaBinPath(opts.env, opts.isProd);
  const r = spawnSync(bin, args, {
    cwd: ROOT,
    env: prismaChildEnv(opts.env, opts.databaseUrl),
    encoding: "utf8",
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (args[0] === "migrate" && args[1] === "deploy") {
    process.stderr.write(r.stderr || "");
    process.stdout.write(r.stdout || "");
  }
  return { status: r.status, out };
}

export function parsePendingFromStatus(statusOut: string): string[] {
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

export function readGitHead(): { head: string; ancestor: boolean } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (head.status !== 0) hold("HOLD: git rev-parse HEAD failed");
  const sha = (head.stdout || "").trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) hold("HOLD: unexpected git HEAD");
  const anc = spawnSync("git", ["merge-base", "--is-ancestor", P4_HEAD_SHA, "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { head: sha, ancestor: anc.status === 0 };
}

export function classifyDatabaseUrl(url: string): {
  isProd: boolean;
  isLocal: boolean;
  host: string;
  dbName: string;
} {
  const parsed = parseDatabaseUrl(url);
  const host = parsed.hostname;
  const dbName = decodeURIComponent((parsed.pathname || "/").replace(/^\//, ""));
  const isProd = isProductionDatabaseUrl(url);
  const isLocal = isLocalDatabaseUrl(url);
  return { isProd, isLocal, host, dbName };
}

export function assertDatabaseTarget(
  url: string | undefined,
  mode: MaintMode
): { isProd: boolean; isLocal: boolean; host: string; dbName: string; url: string } {
  if (!url) hold("HOLD: DATABASE_URL 이 없습니다.");
  const c = classifyDatabaseUrl(url);
  if (c.isProd) {
    if (c.host !== EXPECTED_PROD_HOST) {
      hold(`HOLD: unexpected production host ${maskHost(c.host)}`);
    }
  } else if (!c.isLocal) {
    hold(`HOLD: refusing non-local non-production host ${maskHost(c.host)}`);
  } else if (mode !== "inspect" && c.dbName === "caddy_local") {
    hold(
      "HOLD: local write/sync refuses shared caddy_local — use a throwaway database"
    );
  }
  return { ...c, url };
}

function confirmToken(env: NodeJS.ProcessEnv): string {
  return env.PROD_MAINTENANCE_CONFIRM || "";
}

export function assertWriteConfirm(
  mode: "apply" | "sync-checksums",
  isProd: boolean,
  env: NodeJS.ProcessEnv,
  url: string
): void {
  const got = confirmToken(env);
  const expected = isProd
    ? mode === "apply"
      ? TASK.applyProd
      : TASK.checksumProd
    : mode === "apply"
      ? TASK.applyLocal
      : TASK.checksumLocal;
  if (got !== expected) {
    hold(
      `⛔ production maintenance 차단. 이 스크립트는 PROD_MAINTENANCE_CONFIRM=${expected} 가 필요합니다. ALLOW_PROD_DB 같은 범용 스위치는 없습니다.`
    );
  }
  if (env.ALLOW_PROD_DB) {
    hold("HOLD: ALLOW_PROD_DB is not a valid bypass");
  }
  if (isProd) {
    if (!isProductionDatabaseUrl(url)) {
      hold(`⛔ PROD_MAINTENANCE_CONFIRM 는 production DB 전용입니다. host=${maskHost(parseDatabaseUrl(url).hostname)}`);
    }
    console.error("=== PRODUCTION MAINTENANCE ===");
    console.error("task:", expected);
    console.error("host_masked:", maskHost(parseDatabaseUrl(url).hostname));
    console.error("db:", parseDatabaseUrl(url).pathname.replace(/^\//, ""));
  } else if (isProductionDatabaseUrl(url)) {
    hold("HOLD: local confirm token refused on production URL");
  }
}

function n(v: bigint | number | null | undefined): number {
  return Number(v ?? 0);
}

type CountRow = { n: bigint | number };

async function countTable(prisma: PrismaClient, table: string): Promise<number> {
  const allowed = new Set([
    "Caddy",
    "MarshalProfile",
    "MarshalMonthPlan",
    "MarshalMonthSlot",
    "MarshalPenaltyDuty",
    "MarshalRotationCredit",
    "MarshalPenaltyOccurrence",
    "_prisma_migrations",
  ]);
  if (!allowed.has(table)) hold(`HOLD: refusing count of ${table}`);
  try {
    const rows = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS n FROM "${table}"`
    );
    return n(rows[0]?.n);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|42703|42P01/i.test(msg) && table === "MarshalPenaltyOccurrence") {
      return 0;
    }
    throw e;
  }
}

export type Snapshot = {
  caddyCount: number;
  caddyFp: string;
  marshalCount: number;
  activeCount: number;
  rotationOrders: number[];
  rotationDuplicates: number[];
  plans: number;
  slots: number;
  duties: number;
  credits: number;
  occurrences: number;
};

async function loadSnapshot(prisma: PrismaClient): Promise<Snapshot> {
  const caddies = await prisma.$queryRawUnsafe<
    Array<{
      id: number;
      name: string;
      caddyType: string | null;
      employmentStatus: string | null;
    }>
  >(
    `SELECT id, name, "caddyType"::text AS "caddyType", "employmentStatus"::text AS "employmentStatus"
     FROM "Caddy" ORDER BY id`
  );
  const marshals = await prisma.$queryRawUnsafe<
    Array<{
      id: number;
      caddyId: number;
      active: boolean;
      rotationOrder: number | null;
    }>
  >(
    `SELECT id, "caddyId", active, "rotationOrder" FROM "MarshalProfile" ORDER BY id`
  );
  const active = marshals.filter((m) => m.active);
  const orders = active
    .map((m) => m.rotationOrder)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const seen = new Map<number, number>();
  for (const o of orders) seen.set(o, (seen.get(o) || 0) + 1);
  const rotationDuplicates = [...seen.entries()]
    .filter(([, c]) => c > 1)
    .map(([o]) => o);
  return {
    caddyCount: caddies.length,
    caddyFp: sha256Bytes(
      JSON.stringify(
        caddies.map((c) => [c.id, c.name, c.caddyType, c.employmentStatus])
      )
    ),
    marshalCount: marshals.length,
    activeCount: active.length,
    rotationOrders: orders,
    rotationDuplicates,
    plans: await countTable(prisma, "MarshalMonthPlan"),
    slots: await countTable(prisma, "MarshalMonthSlot"),
    duties: await countTable(prisma, "MarshalPenaltyDuty"),
    credits: await countTable(prisma, "MarshalRotationCredit"),
    occurrences: await countTable(prisma, "MarshalPenaltyOccurrence"),
  };
}

type MigrationRow = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

async function loadMigrations(prisma: PrismaClient): Promise<MigrationRow[]> {
  return prisma.$queryRawUnsafe<MigrationRow[]>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
     FROM "_prisma_migrations"
     ORDER BY started_at`
  );
}

function localMigrationNames(): string[] {
  const dir = path.join(ROOT, "prisma", "migrations");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .sort();
}

export type ChecksumReport = {
  expectedReconstructed: Array<{ name: string; git: string; db: string }>;
  alreadySynced: string[];
  unexpected: Array<{ name: string; git: string; db: string }>;
};

export function classifyChecksums(rows: MigrationRow[]): ChecksumReport {
  const db = new Map(rows.map((r) => [r.migration_name, r.checksum]));
  const expectedReconstructed: ChecksumReport["expectedReconstructed"] = [];
  const alreadySynced: string[] = [];
  const unexpected: ChecksumReport["unexpected"] = [];
  for (const name of localMigrationNames()) {
    const git = gitChecksumFor(name);
    const sum = db.get(name);
    if (!sum) continue;
    if (sum === git) {
      if ((RECONSTRUCTED_NAMES as readonly string[]).includes(name)) {
        alreadySynced.push(name);
      }
      continue;
    }
    if ((RECONSTRUCTED_NAMES as readonly string[]).includes(name)) {
      expectedReconstructed.push({ name, git, db: sum });
    } else {
      unexpected.push({ name, git, db: sum });
    }
  }
  return { expectedReconstructed, alreadySynced, unexpected };
}

async function columnDefault(
  prisma: PrismaClient,
  table: string,
  column: string
): Promise<{ exists: boolean; isNullable: string | null; columnDefault: string | null }> {
  const rows = await prisma.$queryRaw<
    Array<{ is_nullable: string; column_default: string | null }>
  >`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  if (!rows.length) return { exists: false, isNullable: null, columnDefault: null };
  return {
    exists: true,
    isNullable: rows[0].is_nullable,
    columnDefault: rows[0].column_default,
  };
}

async function indexExists(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
  `;
  return n(rows[0]?.n) > 0;
}

async function triggerExists(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS n FROM pg_trigger WHERE tgname = ${name} AND NOT tgisinternal
  `;
  return n(rows[0]?.n) > 0;
}

async function tableExists(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::bigint AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
  `;
  return n(rows[0]?.n) > 0;
}

export type SchemaPost = {
  coverage: { exists: boolean; isNullable: string | null; columnDefault: string | null };
  fillTrigger: boolean;
  occurrenceTable: boolean;
  needsRegeneration: boolean;
  pinnedOn: boolean;
  autoHeldOn: boolean;
  slotShiftCaddyUnique: boolean;
  slotOldCaddyUnique: boolean;
  occurrenceIdempotencyUnique: boolean;
  occurrenceOccurredUnique: boolean;
};

async function loadPostSchema(prisma: PrismaClient): Promise<SchemaPost> {
  const coverage = await columnDefault(prisma, "MarshalPenaltyDuty", "coverage");
  const needs = await columnDefault(prisma, "MarshalMonthPlan", "needsRegeneration");
  const pinned = await columnDefault(prisma, "MarshalPenaltyOccurrence", "pinnedOn");
  const autoHeld = await columnDefault(prisma, "MarshalPenaltyOccurrence", "autoHeldOn");
  return {
    coverage,
    fillTrigger: await triggerExists(prisma, "marshal_penalty_fill_coverage"),
    occurrenceTable: await tableExists(prisma, "MarshalPenaltyOccurrence"),
    needsRegeneration: needs.exists,
    pinnedOn: pinned.exists,
    autoHeldOn: autoHeld.exists,
    slotShiftCaddyUnique: await indexExists(
      prisma,
      "MarshalMonthSlot_planId_date_shift_caddyId_key"
    ),
    slotOldCaddyUnique: await indexExists(
      prisma,
      "MarshalMonthSlot_planId_date_caddyId_key"
    ),
    occurrenceIdempotencyUnique: await indexExists(
      prisma,
      "MarshalPenaltyOccurrence_idempotencyKey_key"
    ),
    occurrenceOccurredUnique: await indexExists(
      prisma,
      "MarshalPenaltyOccurrence_caddyId_occurredOn_key"
    ),
  };
}

export function assertPostSchema(schema: SchemaPost): void {
  if (!schema.coverage.exists) hold("HOLD: coverage column missing");
  if (schema.coverage.isNullable !== "NO") hold("HOLD: coverage must be NOT NULL");
  if (schema.coverage.columnDefault) {
    hold("HOLD: coverage DEFAULT must be dropped");
  }
  if (!schema.fillTrigger) hold("HOLD: marshal_penalty_fill_coverage trigger missing");
  if (!schema.occurrenceTable) hold("HOLD: MarshalPenaltyOccurrence missing");
  if (!schema.needsRegeneration) hold("HOLD: needsRegeneration missing");
  if (!schema.pinnedOn) hold("HOLD: pinnedOn missing");
  if (!schema.autoHeldOn) hold("HOLD: autoHeldOn missing");
  if (!schema.slotShiftCaddyUnique) {
    hold("HOLD: slot UNIQUE (planId, date, shift, caddyId) missing");
  }
  if (schema.slotOldCaddyUnique) {
    hold("HOLD: old slot UNIQUE (planId, date, caddyId) still present");
  }
  if (!schema.occurrenceIdempotencyUnique) {
    hold("HOLD: MarshalPenaltyOccurrence idempotencyKey UNIQUE missing");
  }
  if (schema.occurrenceOccurredUnique) {
    hold("HOLD: old occurrence UNIQUE (caddyId, occurredOn) still present");
  }
}

function expectedActiveCount(isProd: boolean, env: NodeJS.ProcessEnv): number {
  if (isProd) return PROD_ACTIVE_MARSHALS;
  const raw = env.MARSHAL_MAINT_EXPECT_ACTIVE;
  if (raw == null || raw === "") return PROD_ACTIVE_MARSHALS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) hold("HOLD: MARSHAL_MAINT_EXPECT_ACTIVE must be an integer >= 0");
  return v;
}

function rotationExpected(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

function sameOrders(got: number[], expected: number[]): boolean {
  if (got.length !== expected.length) return false;
  return got.every((v, i) => v === expected[i]);
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  return (
    a.caddyCount === b.caddyCount &&
    a.caddyFp === b.caddyFp &&
    a.marshalCount === b.marshalCount &&
    a.activeCount === b.activeCount &&
    a.plans === b.plans &&
    a.slots === b.slots &&
    a.duties === b.duties &&
    a.credits === b.credits &&
    JSON.stringify(a.rotationOrders) === JSON.stringify(b.rotationOrders)
  );
}

async function neonReachableNote(prisma: PrismaClient, isProd: boolean): Promise<{
  isNeon: boolean;
  utcNow: string | null;
  note: string;
}> {
  if (!isProd) {
    return {
      isNeon: false,
      utcNow: null,
      note: "local DB — Neon PITR not applicable",
    };
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ utc_now: Date }>>(
    `SELECT (NOW() AT TIME ZONE 'UTC') AS utc_now`
  );
  return {
    isNeon: true,
    utcNow: rows[0]?.utc_now ? new Date(rows[0].utc_now).toISOString() : null,
    note: "PITR window must be confirmed in Neon console. This tool never creates or restores backups.",
  };
}

type InspectBundle = {
  mode: MaintMode;
  hostMasked: string;
  dbName: string;
  isProd: boolean;
  git: { head: string; requiredAncestor: string; isAncestor: boolean };
  prisma: { cli: string | null; client: string | null; enginesHash: string | null; ok: boolean };
  applied: number;
  unfinished: number;
  pending: string[];
  checksums: ChecksumReport;
  snapshot: Snapshot;
  schema: SchemaPost;
  freezeConfirmed: boolean;
  pitrConfirmed: boolean;
  neon: { isNeon: boolean; utcNow: string | null; note: string };
  holds: string[];
};

function collectHolds(
  bundle: Omit<InspectBundle, "holds">,
  env: NodeJS.ProcessEnv
): string[] {
  const holds: string[] = [];
  if (!bundle.git.isAncestor) {
    holds.push(`git HEAD is not a descendant of P4 ${P4_HEAD_SHA}`);
  }
  if (!bundle.prisma.ok) holds.push("Prisma CLI/client is not 5.22.x with expected engines hash");
  if (bundle.unfinished !== 0) holds.push(`unfinished migrations ${bundle.unfinished}`);
  if (bundle.checksums.unexpected.length) {
    holds.push(
      `unexpected checksum mismatch ${bundle.checksums.unexpected.map((u) => u.name).join(",")}`
    );
  }
  if (bundle.applied !== APPLIED_BEFORE && bundle.applied !== APPLIED_AFTER) {
    holds.push(`applied migration count ${bundle.applied} is not ${APPLIED_BEFORE} or ${APPLIED_AFTER}`);
  }
  const pendingOk53 =
    bundle.applied === APPLIED_BEFORE &&
    bundle.pending.length === PENDING_NAMES.length &&
    bundle.pending.every((n, i) => n === PENDING_NAMES[i]);
  const pendingOk60 = bundle.applied === APPLIED_AFTER && bundle.pending.length === 0;
  if (!pendingOk53 && !pendingOk60) {
    holds.push(`pending ${JSON.stringify(bundle.pending)} does not match 7 P1–P3 or already-applied`);
  }
  const expectActive = expectedActiveCount(bundle.isProd, env);
  if (bundle.snapshot.activeCount !== expectActive) {
    holds.push(
      `active marshals ${bundle.snapshot.activeCount} != expected ${expectActive}`
    );
  }
  if (expectActive > 0) {
    if (bundle.snapshot.rotationDuplicates.length) {
      holds.push(`rotationOrder duplicates ${bundle.snapshot.rotationDuplicates.join(",")}`);
    }
    if (!sameOrders(bundle.snapshot.rotationOrders, rotationExpected(expectActive))) {
      holds.push("rotationOrder is not contiguous 1..N without gaps");
    }
  }
  return holds;
}

async function inspectDatabase(
  prisma: PrismaClient,
  ctx: {
    mode: MaintMode;
    isProd: boolean;
    host: string;
    dbName: string;
    env: NodeJS.ProcessEnv;
    git: { head: string; ancestor: boolean };
    prismaVer: { cli: string | null; client: string | null; enginesHash: string | null };
  }
): Promise<InspectBundle> {
  const rows = await loadMigrations(prisma);
  const unfinished = rows.filter((r) => r.finished_at == null).length;
  const applied = rows.filter((r) => r.finished_at != null).length;
  const appliedNames = new Set(rows.map((r) => r.migration_name));
  const pending = PENDING_NAMES.filter((n) => !appliedNames.has(n));
  const extraLocal = localMigrationNames().filter(
    (n) => !appliedNames.has(n) && !(PENDING_NAMES as readonly string[]).includes(n)
  );
  const snapshot = await loadSnapshot(prisma);
  const schema = await loadPostSchema(prisma);
  const neon = await neonReachableNote(prisma, ctx.isProd);
  const prismaOk =
    prismaSeriesOk(ctx.prismaVer.cli) &&
    prismaSeriesOk(ctx.prismaVer.client) &&
    ctx.prismaVer.enginesHash === EXPECTED_ENGINES_HASH;
  const base: Omit<InspectBundle, "holds"> = {
    mode: ctx.mode,
    hostMasked: maskHost(ctx.host),
    dbName: ctx.dbName,
    isProd: ctx.isProd,
    git: {
      head: ctx.git.head,
      requiredAncestor: P4_HEAD_SHA,
      isAncestor: ctx.git.ancestor,
    },
    prisma: { ...ctx.prismaVer, ok: prismaOk },
    applied,
    unfinished,
    pending: extraLocal.length ? [...pending, ...extraLocal] : pending,
    checksums: classifyChecksums(rows),
    snapshot,
    schema,
    freezeConfirmed: ctx.env.MARSHAL_WRITE_FREEZE_CONFIRM === TASK.freeze,
    pitrConfirmed: ctx.env.NEON_PITR_WINDOW_CONFIRMED === TASK.pitr,
    neon,
  };
  return { ...base, holds: collectHolds(base, ctx.env) };
}

function publicReport(bundle: InspectBundle, extra: Record<string, unknown> = {}) {
  return {
    ok: bundle.holds.length === 0,
    mergeHold: true,
    mode: bundle.mode,
    hostMasked: bundle.hostMasked,
    dbName: bundle.dbName,
    isProd: bundle.isProd,
    git: bundle.git,
    prisma: bundle.prisma,
    applied: bundle.applied,
    unfinished: bundle.unfinished,
    pending: bundle.pending,
    checksums: {
      expectedReconstructed: bundle.checksums.expectedReconstructed.map((m) => m.name),
      alreadySynced: bundle.checksums.alreadySynced,
      unexpected: bundle.checksums.unexpected.map((m) => m.name),
    },
    marshals: {
      total: bundle.snapshot.marshalCount,
      active: bundle.snapshot.activeCount,
      rotationOrders: bundle.snapshot.rotationOrders,
      duplicates: bundle.snapshot.rotationDuplicates,
    },
    existing: {
      caddies: bundle.snapshot.caddyCount,
      caddyFp: bundle.snapshot.caddyFp,
      plans: bundle.snapshot.plans,
      slots: bundle.snapshot.slots,
      duties: bundle.snapshot.duties,
      credits: bundle.snapshot.credits,
      occurrences: bundle.snapshot.occurrences,
    },
    schema: bundle.schema,
    freeze: {
      confirmed: bundle.freezeConfirmed,
      requiredUntilP1Files: P1_FREEZE_UNTIL,
      note: "Marshal write freeze stays in effect until P1 migrations 1–3 have finished.",
    },
    neonPitr: {
      confirmed: bundle.pitrConfirmed,
      ...bundle.neon,
    },
    holds: bundle.holds,
    ...extra,
  };
}

async function syncChecksums(prisma: PrismaClient, bundle: InspectBundle): Promise<void> {
  if (bundle.holds.length) {
    hold(`HOLD: inspect holds block checksum sync: ${bundle.holds.join("; ")}`);
  }
  const results: Array<{ name: string; action: string }> = [];
  for (const name of RECONSTRUCTED_NAMES) {
    const git = gitChecksumFor(name);
    const row = (
      await prisma.$queryRaw<Array<{ checksum: string }>>`
        SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ${name}
      `
    )[0];
    if (!row) hold(`HOLD: reconstructed migration ${name} is not applied`);
    if (row.checksum === git) {
      results.push({ name, action: "already-synced" });
      continue;
    }
    const expectedOld = EXPECTED_PROD_RECONSTRUCTED_CHECKSUMS[name];
    if (row.checksum !== expectedOld) {
      hold(
        `HOLD: ${name} checksum is neither git nor the known reconstructed production value`
      );
    }
    const updated = await prisma.$executeRaw`
      UPDATE "_prisma_migrations"
      SET checksum = ${git}
      WHERE migration_name = ${name}
        AND checksum = ${expectedOld}
    `;
    if (Number(updated) !== 1) {
      hold(`HOLD: checksum UPDATE for ${name} affected ${updated} rows`);
    }
    results.push({ name, action: "updated" });
  }
  console.log(
    JSON.stringify(
      publicReport(bundle, { ok: true, checksumSync: results, wrote: true }),
      null,
      2
    )
  );
}

function assertApplyExtras(bundle: InspectBundle, env: NodeJS.ProcessEnv): void {
  if (bundle.holds.length) {
    hold(`HOLD: pre-apply inspect failed: ${bundle.holds.join("; ")}`);
  }
  if (env.MARSHAL_WRITE_FREEZE_CONFIRM !== TASK.freeze) {
    hold("HOLD: apply requires MARSHAL_WRITE_FREEZE_CONFIRM=HELD");
  }
  if (bundle.isProd && env.NEON_PITR_WINDOW_CONFIRMED !== TASK.pitr) {
    hold("HOLD: production apply requires NEON_PITR_WINDOW_CONFIRMED=YES (console PITR, not taken here)");
  }
  const allowPlans = env.MARSHAL_MAINT_ALLOW_EXISTING_PLANS === "YES";
  if (!allowPlans) {
    if (bundle.snapshot.plans > 0 || bundle.snapshot.slots > 0 || bundle.snapshot.duties > 0) {
      hold(
        "HOLD: existing month plans/slots/penalty duties present. Set MARSHAL_MAINT_ALLOW_EXISTING_PLANS=YES only after explicit review."
      );
    }
  }
}

function assertDeployOutput(out: string, status: number | null): void {
  if (/P3018/.test(out)) {
    hold("HOLD: prisma P3018 — abort immediately. Do not migrate resolve.");
  }
  if (/P3009/.test(out)) {
    hold("HOLD: prisma P3009 unfinished migration — abort immediately. Do not migrate resolve.");
  }
  if (status !== 0) {
    hold(`HOLD: prisma migrate deploy failed (exit ${status})`);
  }
}

export async function runMarshalPenaltyMaint(opts?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const argv = opts?.argv ?? process.argv.slice(2);
  const env = opts?.env ?? process.env;
  const mode = parseMaintMode(argv);
  auditPendingSql();
  const target = assertDatabaseTarget(env.DATABASE_URL, mode);
  console.error("=== MARSHAL P1–P3 MAINTENANCE ===");
  console.error("mode:", mode);
  console.error("host_masked:", maskHost(target.host));
  console.error("db:", target.dbName);
  console.error("prod:", target.isProd);

  if (mode !== "inspect") {
    assertWriteConfirm(mode, target.isProd, env, target.url);
  }

  const git = readGitHead();
  const verRun = runPrisma(["--version"], {
    env,
    databaseUrl: target.url,
    isProd: target.isProd,
    allowDeploy: false,
  });
  if (verRun.status !== 0) hold("HOLD: prisma --version failed");
  const prismaVer = parsePrismaVersion(verRun.out);
  if (
    !prismaSeriesOk(prismaVer.cli) ||
    !prismaSeriesOk(prismaVer.client) ||
    prismaVer.enginesHash !== EXPECTED_ENGINES_HASH
  ) {
    hold(
      `HOLD: Prisma must be ${EXPECTED_PRISMA_SERIES}.x engines ${EXPECTED_ENGINES_HASH} (cli=${prismaVer.cli} client=${prismaVer.client} engines=${prismaVer.enginesHash})`
    );
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: target.url } },
  });
  try {
    const bundle = await inspectDatabase(prisma, {
      mode,
      isProd: target.isProd,
      host: target.host,
      dbName: target.dbName,
      env,
      git: { head: git.head, ancestor: git.ancestor },
      prismaVer,
    });

    if (mode === "inspect") {
      const report = publicReport(bundle, { wrote: false });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }

    if (mode === "sync-checksums") {
      await syncChecksums(prisma, bundle);
      return 0;
    }

    assertApplyExtras(bundle, env);
    const before = bundle.snapshot;

    if (bundle.applied === APPLIED_AFTER && bundle.pending.length === 0) {
      assertPostSchema(bundle.schema);
      const after = await loadSnapshot(prisma);
      if (!snapshotsEqual(before, after)) {
        hold("HOLD: already-applied path changed caddy/marshal snapshot");
      }
      console.log(
        JSON.stringify(
          publicReport(bundle, {
            ok: true,
            applyMode: "already-applied",
            identityUnchanged: true,
            wrote: false,
          }),
          null,
          2
        )
      );
      return 0;
    }

    const statusRun = runPrisma(["migrate", "status"], {
      env,
      databaseUrl: target.url,
      isProd: target.isProd,
      allowDeploy: false,
    });
    const statusPending = parsePendingFromStatus(statusRun.out);
    if (
      statusPending.length !== PENDING_NAMES.length ||
      statusPending.some((n, i) => n !== PENDING_NAMES[i])
    ) {
      hold(
        `HOLD: prisma migrate status pending ${JSON.stringify(statusPending)} != expected 7`
      );
    }

    console.error("=== prisma migrate deploy (no extra flags, no resolve) ===");
    console.error("freeze: held until", P1_FREEZE_UNTIL.join(", "));
    const deploy = runPrisma(["migrate", "deploy"], {
      env,
      databaseUrl: target.url,
      isProd: target.isProd,
      allowDeploy: true,
    });
    assertDeployOutput(deploy.out, deploy.status);

    const afterRows = await loadMigrations(prisma);
    const afterUnfinished = afterRows.filter((r) => r.finished_at == null).length;
    const afterApplied = afterRows.filter((r) => r.finished_at != null).length;
    if (afterUnfinished !== 0) hold(`HOLD: unfinished after deploy ${afterUnfinished}`);
    if (afterApplied !== APPLIED_AFTER) {
      hold(`HOLD: applied after deploy ${afterApplied} != ${APPLIED_AFTER}`);
    }
    const afterSchema = await loadPostSchema(prisma);
    assertPostSchema(afterSchema);
    const afterSnap = await loadSnapshot(prisma);
    if (afterSnap.occurrences !== before.occurrences && before.occurrences !== 0) {
      hold("HOLD: MarshalPenaltyOccurrence row count changed unexpectedly");
    }
    if (!snapshotsEqual(before, { ...afterSnap, occurrences: before.occurrences })) {
      hold("HOLD: caddy/marshal snapshot changed after migrate deploy");
    }

    const afterBundle: InspectBundle = {
      ...bundle,
      applied: afterApplied,
      unfinished: afterUnfinished,
      pending: [],
      schema: afterSchema,
      snapshot: afterSnap,
      checksums: classifyChecksums(afterRows),
      holds: [],
    };
    console.log(
      JSON.stringify(
        publicReport(afterBundle, {
          ok: true,
          applyMode: "deployed",
          identityUnchanged: true,
          wrote: true,
          p1FreezeCanLift: true,
        }),
        null,
        2
      )
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const code = await runMarshalPenaltyMaint({ argv, env: process.env });
    process.exitCode = code;
  } catch (e) {
    const err = e as HoldError;
    const msg = err instanceof Error ? err.message : String(e);
    console.error(msg);
    if (err && err.report) {
      console.log(JSON.stringify({ ok: false, mergeHold: true, error: msg, report: err.report }, null, 2));
    }
    process.exit(1);
  }
}
