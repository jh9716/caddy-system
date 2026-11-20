// Preview DB 상태 판정 (읽기 전용, psql 사용). 출력은 집계·이름만, 비밀값 없음.
// 사용: node scripts/preview-db/state.cjs <precheck|migrate-gate|seed-gate|verify> [--local-harness]
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validatePreviewDbUrl } = require("./validate-url.cjs");

const { listRepoMigrations, classifyMigrationState, repoMigrationChecksums } = require("./migration-state.cjs");
const {
  gateCommentRepliesPreviewMigrate,
  gateCommunityFreeBoardPreviewMigrate,
  isCommentRepliesPreviewBranch,
  isCommunityFreeBoardPreviewBranch,
  COMMENT_REPLIES_MIGRATION,
  COMMUNITY_FREE_BOARD_MIGRATION,
  COMMUNITY_FREE_BOARD_MIGRATION_SHA256,
} = require("../maintenance/single-migration-gate.cjs");
// PR #380: migrate-gate 가 남기는 migrate 직전 지문 (같은 job 의 verify 가 비교). 값에 비밀·개인정보 없음.
const COMMUNITY_SNAPSHOT_FILE =
  process.env.PREVIEW_DB_COMMUNITY_SNAPSHOT || path.join(os.tmpdir(), "preview-db-pr380-community-before.json");
const COMMUNITY_SNAPSHOT_KEYS = [
  "snap_user_total",
  "snap_user_id_fp",
  "snap_caddy_total",
  "snap_caddy_id_fp",
  "snap_comment_total",
  "snap_comment_row_fp",
  "snap_thread_total",
  "snap_thread_row_fp",
  "snap_free_board_post_total",
  "snap_free_board_post_row_fp",
  "snap_free_board_photo_total",
  "snap_free_board_photo_row_fp",
];
function readCommunitySnapshot() {
  const snap = psql(fs.readFileSync(path.join(__dirname, "community-snapshot-readonly.sql"), "utf8"));
  for (const k of COMMUNITY_SNAPSHOT_KEYS) {
    if (!snap[k]) die(`community snapshot missing ${k}`);
  }
  return snap;
}
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

function readPrismaMigrationNames() {
  const q = psql(`BEGIN TRANSACTION READ ONLY;
SELECT 'applied=' || coalesce(string_agg(migration_name, ',' ORDER BY migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'failed=' || count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
SELECT 'failed_names=' || coalesce(string_agg(migration_name, ',' ORDER BY migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
SELECT 'checksums=' || coalesce(string_agg(migration_name || ':' || coalesce(checksum, ''), ',' ORDER BY migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
ROLLBACK;`);
  const checksums = {};
  for (const pair of q.checksums ? q.checksums.split(",") : []) {
    const i = pair.indexOf(":");
    if (i > 0) checksums[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return {
    applied: q.applied ? q.applied.split(",") : [],
    failed: Number(q.failed),
    failedNames: q.failed_names ? q.failed_names.split(",") : [],
    checksums,
  };
}

let applied = [];
let failed = 0;
let failedNames = [];
let appliedChecksums = {};
if (hasPm) {
  const q = readPrismaMigrationNames();
  applied = q.applied;
  failed = q.failed;
  failedNames = q.failedNames;
  appliedChecksums = q.checksums;
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

const commentTable = psql(`BEGIN TRANSACTION READ ONLY;
SELECT 'comment_table=' || (to_regclass('public."Comment"') IS NOT NULL);
ROLLBACK;`);
report.comment_table = commentTable.comment_table || "false";
if (commentTable.comment_table === "true") {
  const commentCounts = psql(`BEGIN TRANSACTION READ ONLY;
SELECT 'comment_total=' || count(*)::text FROM "Comment";
SELECT 'comment_id_fingerprint=' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') FROM "Comment";
ROLLBACK;`);
  report.comment_total = commentCounts.comment_total || "0";
  report.comment_id_fingerprint = commentCounts.comment_id_fingerprint || "empty";
}

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
  if (vr.comment_parentid_column !== "1") die("Comment.parentId column missing");
  if (vr.comment_parentid_nullable !== "YES") die("Comment.parentId must be nullable");
  if (vr.comment_parentid_fk !== "1") die("Comment.parentId FK missing");
  if (vr.comment_parentid_fk_delete !== "RESTRICT") die("Comment.parentId FK must be ON DELETE RESTRICT");
  if (vr.comment_replies_migration !== "1") die("comment_replies_v1 migration not finished");
  const commentTotal = Number(vr.comment_total);
  const commentNull = Number(vr.comment_parent_null);
  const commentSet = Number(vr.comment_parent_set);
  if (!Number.isFinite(commentTotal) || commentTotal < 0) die("Comment total missing");
  if (commentNull + commentSet !== commentTotal) {
    die(`Comment parentId accounting mismatch ${commentTotal} != ${commentNull}+${commentSet}`);
  }
  if (report.comment_total && report.comment_total !== vr.comment_total) {
    die(`Comment row count changed during verify ${report.comment_total} → ${vr.comment_total}`);
  }
  if (report.comment_id_fingerprint && vr.comment_id_fingerprint && report.comment_id_fingerprint !== vr.comment_id_fingerprint) {
    die("Comment id fingerprint changed; existing rows were modified");
  }
  const verifyRef = process.env.PREVIEW_REF_NAME || process.env.GITHUB_REF_NAME || "";
  if (isCommunityFreeBoardPreviewBranch(verifyRef)) {
    const cv = psql(fs.readFileSync(path.join(__dirname, "community-verify-readonly.sql"), "utf8"));
    for (const [k, val] of Object.entries(cv)) console.log(`verify.${k}=${val}`);
    if (cv.community_post_table !== "1") die("CommunityPost table missing");
    if (cv.community_photo_table !== "1") die("CommunityPhoto table missing");
    if (cv.community_post_author_fk_delete !== "RESTRICT") die("CommunityPost author FK must be ON DELETE RESTRICT");
    if (cv.community_photo_post_fk_delete !== "CASCADE") die("CommunityPhoto post FK must be ON DELETE CASCADE");
    if (cv.community_board_type_enum !== "FREE") die("CommunityBoardType enum must be exactly FREE");
    if (cv.comment_target_community_post !== "1") die("CommentTargetType COMMUNITY_POST missing");
    if (cv.community_posts !== "0") die("CommunityPost must be empty after migrate (no seed)");
    if (cv.community_photos !== "0") die("CommunityPhoto must be empty after migrate (no seed)");
    if (cv.community_comment_threads !== "0") die("COMMUNITY_POST comment threads must be empty after migrate");
    if (cv.community_migration_finished !== "1") die("community_free_board_v1 migration not finished");
    if (cv.community_migration_checksum !== COMMUNITY_FREE_BOARD_MIGRATION_SHA256) die("community_free_board_v1 checksum mismatch");
    if (cv.migrations_not_ok !== "0") die("failed or rolled-back migrations present");
    const after = readCommunitySnapshot();
    if (fs.existsSync(COMMUNITY_SNAPSHOT_FILE)) {
      let before;
      try {
        before = JSON.parse(fs.readFileSync(COMMUNITY_SNAPSHOT_FILE, "utf8"));
      } catch {
        die("community before-snapshot unreadable");
      }
      for (const k of COMMUNITY_SNAPSHOT_KEYS) {
        if (!before || before[k] !== after[k]) die(`existing data changed across migrate (${k})`);
      }
      console.log("community_before_after=identical");
    } else {
      console.log("community_before_after=no-before-snapshot (standalone verify; structure checks only)");
    }
  }
  process.exit(0);
}
if (mode === "migrate-gate") {
  const refName = process.env.PREVIEW_REF_NAME || process.env.GITHUB_REF_NAME || "";
  report.ref_name = refName;
  console.log(`ref_name=${refName}`);
  if (isCommunityFreeBoardPreviewBranch(refName)) {
    // PR #380 전용: 66 적용 + checksum 일치 + 대상 1개만 pending + 대상 SQL sha 고정. 어떤 오류든 HOLD (fail-closed).
    let gate;
    let pendingAgain = [];
    try {
      if (!hasPm) die("HOLD: community migrate requires _prisma_migrations");
      if (state !== "PARTIALLY_MIGRATED") die(`HOLD: community migrate requires PARTIALLY_MIGRATED (state ${state})`);
      const migDir = path.join(__dirname, "..", "..", "prisma", "migrations");
      const repoChecksums = repoMigrationChecksums(migDir, repoMigrations);
      const repoAgain = listRepoMigrations(migDir);
      const repoChecksumsAgain = repoMigrationChecksums(migDir, repoAgain);
      const again = readPrismaMigrationNames();
      pendingAgain = repoAgain.filter((m) => !again.applied.includes(m));
      const pendingFirst = repoMigrations.filter((m) => !applied.includes(m));
      gate = gateCommunityFreeBoardPreviewMigrate({
        refName,
        previewProjectId: process.env.PREVIEW_PROJECT_ID,
        neonEndpoint: base.neon_endpoint,
        repo: repoMigrations,
        appliedFinished: applied,
        failedNames,
        statusPending: pendingFirst,
        repoChecksums,
        appliedChecksums,
        repoAgain,
        appliedFinishedAgain: again.applied,
        failedNamesAgain: again.failedNames,
        statusPendingAgain: pendingAgain,
        repoChecksumsAgain,
        appliedChecksumsAgain: again.checksums,
      });
    } catch (e) {
      die(`HOLD: community gate error (${e && e.message ? e.message : "unknown"})`);
    }
    console.log(`community_free_board_gate=${gate.action}`);
    console.log(`community_free_board_target=${COMMUNITY_FREE_BOARD_MIGRATION}`);
    console.log(`community_free_board_target_sha256=${COMMUNITY_FREE_BOARD_MIGRATION_SHA256}`);
    console.log(`pending_migrations=${pendingAgain.length}`);
    if (gate.action !== "allow") die(`HOLD: ${gate.reason}`);
    // migrate 직전 지문 저장 (verify 가 비교). 저장 실패 시 HOLD.
    const snap = readCommunitySnapshot();
    try {
      fs.writeFileSync(COMMUNITY_SNAPSHOT_FILE, JSON.stringify(snap), { mode: 0o600 });
    } catch {
      die("HOLD: cannot write community before-snapshot");
    }
    for (const k of COMMUNITY_SNAPSHOT_KEYS) console.log(`before.${k}=${snap[k]}`);
    process.exit(0);
  }
  if (isCommentRepliesPreviewBranch(refName)) {
    if (!hasPm) die("HOLD: comment-replies migrate requires _prisma_migrations");
    const repoAgain = listRepoMigrations(path.join(__dirname, "..", "..", "prisma", "migrations"));
    const again = readPrismaMigrationNames();
    const pending = repoAgain.filter((m) => !again.applied.includes(m));
    const pendingFirst = repoMigrations.filter((m) => !applied.includes(m));
    const gate = gateCommentRepliesPreviewMigrate({
      refName,
      previewProjectId: process.env.PREVIEW_PROJECT_ID,
      neonEndpoint: base.neon_endpoint,
      repo: repoMigrations,
      appliedFinished: applied,
      failedNames,
      statusPending: pendingFirst,
      repoAgain,
      appliedFinishedAgain: again.applied,
      failedNamesAgain: again.failedNames,
      statusPendingAgain: pending,
    });
    console.log(`comment_replies_gate=${gate.action}`);
    console.log(`comment_replies_target=${COMMENT_REPLIES_MIGRATION}`);
    console.log(`pending_migrations=${pending.length}`);
    if (gate.action !== "allow") die(`HOLD: ${gate.reason}`);
    process.exit(0);
  }
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
