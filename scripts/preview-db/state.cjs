// Preview DB 상태 판정 (읽기 전용, psql 사용). 출력은 집계·이름만, 비밀값 없음.
// 사용: node scripts/preview-db/state.cjs <precheck|migrate-gate|seed-gate|verify> [--local-harness]
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { validatePreviewDbUrl } = require("./validate-url.cjs");

const { listRepoMigrations, classifyMigrationState } = require("./migration-state.cjs");
const mode = process.argv[2];
const localHarness = process.argv.includes("--local-harness");
if (localHarness && process.env.GITHUB_ACTIONS === "true") die("--local-harness not allowed in Actions");
function die(msg) {
  console.error("preview-db state: STOP - " + msg);
  process.exit(2);
}

const url = process.env.DATABASE_URL || "";
const v = validatePreviewDbUrl(url, { localHarness });
if (!v.ok) die(`url rejected (${v.reason})`);

function psql(sql) {
  // URL 은 환경변수 PG* 로만 전달 (명령행·로그에 남지 않음)
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: localHarness ? "disable" : "require",
    PGAPPNAME: "verthill-preview-db-precheck",
    PGOPTIONS: "-c default_transaction_read_only=on",
  };
  delete env.DATABASE_URL;
  const r = spawnSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql, env, encoding: "utf8" });
  if (r.status !== 0) die("psql failed (" + String(r.stderr || "").split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<url>") + ")");
  const out = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const base = psql(fs.readFileSync(path.join(__dirname, "precheck.sql"), "utf8"));
if (base.database !== "neondb") die("current_database is not neondb");
if (base.read_only !== "on") die("session is not read-only");
const tables = Number(base.public_tables);
const hasPm = base.has_prisma_migrations === "true";
const report = { ...base };

let repoMigrations;
try {
  // 기대 migration = 체크아웃된 ref 의 prisma/migrations (하드코딩 없음)
  repoMigrations = listRepoMigrations(path.join(__dirname, "..", "..", "prisma", "migrations"));
} catch (e) {
  die(`repo migrations invalid (${e.message})`);
}
report.repo_migrations = String(repoMigrations.length);

let applied = [];
let failed = 0;
if (hasPm) {
  const q = psql(`BEGIN TRANSACTION READ ONLY;
SELECT 'applied=' || coalesce(string_agg(migration_name, ',' ORDER BY migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'failed=' || count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
ROLLBACK;`);
  applied = q.applied ? q.applied.split(",") : [];
  failed = Number(q.failed);
  report.applied_migrations = String(applied.length);
  report.failed_migrations = String(failed);
}
const cls = classifyMigrationState({
  tables,
  otherObjects: Number(base.public_other_objects),
  hasPm,
  applied,
  failed,
  repo: repoMigrations,
});
const state = cls.state;
report.expected_migrations = String(cls.expected);
report.missing_migrations = String(cls.missing.length);
report.unknown_migrations = String(cls.unknown.length);
report.state = state;

if (mode === "seed-gate" && state === "MIGRATED") {
  const c = psql(`BEGIN TRANSACTION READ ONLY;
SELECT 'users=' || count(*) FROM "User";
SELECT 'caddies=' || count(*) FROM "Caddy";
SELECT 'plans=' || count(*) FROM "MarshalMonthPlan";
ROLLBACK;`);
  Object.assign(report, c);
}

for (const [k, val] of Object.entries(report)) console.log(`${k}=${val}`);

if (mode === "precheck") process.exit(0);
if (mode === "verify") {
  if (state !== "MIGRATED") die(`verify expects MIGRATED (state ${state})`);
  const raw = fs.readFileSync(path.join(__dirname, "verify-readonly.sql"), "utf8");
  const vr = psql(raw);
  for (const [k, val] of Object.entries(vr)) console.log(`verify.${k}=${val}`);
  if (Number(vr.users_non_test) || Number(vr.caddies_non_test)) die("non-test users/caddies found");
  if (Number(vr.migrations_failed)) die("failed migrations present");
  process.exit(0);
}
if (mode === "migrate-gate") {
  if (state === "EMPTY" || state === "PARTIALLY_MIGRATED") process.exit(0);
  if (state === "MIGRATED") die("already fully migrated; nothing to do");
  die(`refusing to migrate in state ${state}`);
}
if (mode === "seed-gate") {
  if (state !== "MIGRATED") die(`seed requires all ${repoMigrations.length} repo migrations applied (state ${state})`);
  if (Number(report.users) || Number(report.caddies) || Number(report.plans)) die("seed data already present; refusing (refuse-by-default)");
  process.exit(0);
}
die("unknown mode");
