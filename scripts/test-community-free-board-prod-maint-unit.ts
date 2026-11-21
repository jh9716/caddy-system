/**
 * 자유게시판 V1 Production migration 안전장치 단위 테스트.
 * DB·네트워크 접근 없음 (mock 데이터만). 실제 migration 실행 없음.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BACKUP_BRANCH_RE,
  EXPECTED_BRANCH_ID,
  EXPECTED_ENDPOINT_ID,
  EXPECTED_HOST,
  MIGRATION_NAME,
  PINNED_TARGET_SHA256,
  ROOT,
  SQL_REL,
  TASK_IDS,
  allowedPrismaArgs,
  assertCommunityProdUrl,
  assertCommunitySchemaAfter,
  assertNeonIdentity,
  assertPinnedTargetChecksum,
  auditCommunityMigrationSql,
  compareFingerprints,
  confirmPhrase,
  decideCommunityMigration,
  migrationChecksum,
  repoChecksums,
  resolveModeAndConfirm,
  summarizeMigrationRows,
  type AppliedRow,
  type GateFn,
  type SchemaProbe,
} from "./maintenance/communityFreeBoardProd";

const requireCjs = createRequire(__filename);
const { listRepoMigrations } = requireCjs("./preview-db/migration-state.cjs") as {
  listRepoMigrations: (dir: string) => string[];
};
const { gateSingleMigration, parsePrismaMigrateStatusPending } = requireCjs("./maintenance/single-migration-gate.cjs") as {
  gateSingleMigration: GateFn;
  parsePrismaMigrateStatusPending: (s: string) => string[];
};

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}
function throws(fn: () => unknown, msg: string, re?: RegExp) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    assert(!re || re.test(m), `${msg}${re && !re.test(m) ? ` (got: ${m})` : ""}`);
  }
}

// ── 모드·확인 문구 ─────────────────────────────────────────
console.log("== mode / confirm phrase ==");
const pre = {
  PROD_DB_MODE: "precheck",
  PROD_MAINTENANCE_CONFIRM: TASK_IDS.precheck,
  PROD_DB_CONFIRM: confirmPhrase("precheck"),
};
const mig = {
  PROD_DB_MODE: "migrate",
  PROD_MAINTENANCE_CONFIRM: TASK_IDS.migrate,
  PROD_DB_CONFIRM: confirmPhrase("migrate"),
  NEON_PITR_WINDOW_CONFIRMED: "YES",
  NEON_BACKUP_BRANCH: "backup-pre-pr380-prod-20261122",
};
assert(confirmPhrase("precheck") === `PROD-DB-PRECHECK morning-tooth-60659454 ${MIGRATION_NAME}`, "precheck 문구 고정");
assert(confirmPhrase("migrate") === `PROD-DB-MIGRATE morning-tooth-60659454 ${MIGRATION_NAME}`, "migrate 문구 고정");
assert(TASK_IDS.precheck !== TASK_IDS.migrate, "모드별 task id 분리");
assert(resolveModeAndConfirm(pre) === "precheck", "precheck 정상");
assert(resolveModeAndConfirm(mig) === "migrate", "migrate 정상");
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_MODE: undefined }), "모드 없음 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_MODE: "deploy" }), "알 수 없는 모드 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_MODE: "MIGRATE" }), "대문자 모드 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_CONFIRM: undefined }), "확인 문구 누락 차단", /phrase/);
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_CONFIRM: confirmPhrase("precheck") + " " }), "확인 문구 공백 차단", /phrase/);
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_CONFIRM: "PROD-DB-PRECHECK lucky-mode-29989630 " + MIGRATION_NAME }), "Preview 프로젝트 문구 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_MAINTENANCE_CONFIRM: undefined }), "task id 누락 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_MAINTENANCE_CONFIRM: "TEAM_AFFILIATION_SETTINGS_20261117" }), "다른 작업 task id 차단");
throws(() => resolveModeAndConfirm({ ...pre, PROD_MAINTENANCE_CONFIRM: TASK_IDS.migrate }), "모드 혼동: precheck + migrate task id", /mode confusion/);
throws(() => resolveModeAndConfirm({ ...pre, PROD_DB_CONFIRM: confirmPhrase("migrate") }), "모드 혼동: precheck + migrate 문구", /mode confusion/);
throws(() => resolveModeAndConfirm({ ...mig, PROD_MAINTENANCE_CONFIRM: TASK_IDS.precheck }), "모드 혼동: migrate + precheck task id", /mode confusion/);
throws(() => resolveModeAndConfirm({ ...mig, PROD_DB_CONFIRM: confirmPhrase("precheck") }), "모드 혼동: migrate + precheck 문구", /mode confusion/);
throws(() => resolveModeAndConfirm({ ...mig, NEON_PITR_WINDOW_CONFIRMED: "NO" }), "migrate: PITR 미확인 차단", /PITR/);
throws(() => resolveModeAndConfirm({ ...mig, NEON_BACKUP_BRANCH: "" }), "migrate: 백업 브랜치 누락 차단", /BACKUP/);
throws(() => resolveModeAndConfirm({ ...mig, NEON_BACKUP_BRANCH: "backup-pre-pr380-20261120" }), "migrate: Preview 백업 브랜치 이름 차단");
throws(() => resolveModeAndConfirm({ ...mig, NEON_BACKUP_BRANCH: "backup-pre-pr380-prod-*" }), "migrate: 와일드카드 백업 이름 차단");
assert(BACKUP_BRANCH_RE.test("backup-pre-pr380-prod-20261122"), "백업 브랜치 형식 허용");

// ── URL / 엔드포인트 ─────────────────────────────────────────
console.log("== endpoint ==");
const prodUrl = `postgresql://u_test:pw_test@${EXPECTED_HOST}/neondb?sslmode=require`;
assert(assertCommunityProdUrl(prodUrl).host === EXPECTED_HOST, "운영 direct endpoint 허용");
throws(() => assertCommunityProdUrl(undefined), "URL 없음 차단");
throws(() => assertCommunityProdUrl("postgresql://u:p@ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"), "Preview endpoint 차단", /Preview/);
throws(() => assertCommunityProdUrl(`${prodUrl}&options=project%3Dlucky-mode-29989630`), "Preview 프로젝트 문자열 차단", /Preview/);
throws(() => assertCommunityProdUrl(`postgresql://u:p@ep-crimson-cell-a1i1tpce-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`), "pooler 차단");
throws(() => assertCommunityProdUrl(`${prodUrl}&pgbouncer=true`), "pgbouncer 차단");
throws(() => assertCommunityProdUrl(`postgresql://u:p@ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech.evil.com/neondb`), "호스트 뒤 도메인 차단");
throws(() => assertCommunityProdUrl(`postgresql://u:p@ep-other-abc.ap-southeast-1.aws.neon.tech/neondb`), "다른 endpoint 차단");
throws(() => assertCommunityProdUrl(`postgresql://u:p@${EXPECTED_HOST}/postgres`), "다른 DB 차단");
throws(() => assertCommunityProdUrl(`postgresql://u:p@${EXPECTED_HOST}:6543/neondb`), "다른 포트 차단");
throws(() => assertCommunityProdUrl(`postgresql://u:p@127.0.0.1:5432/neondb`), "localhost 차단");
try {
  assertCommunityProdUrl("postgresql://SECRETUSER:SECRETPW@evil.com/neondb");
} catch (e) {
  assert(!String(e).includes("SECRET"), "오류 메시지에 자격 증명 없음");
}

console.log("== neon identity ==");
assertNeonIdentity({ database: "neondb", endpoint: EXPECTED_ENDPOINT_ID, branch: EXPECTED_BRANCH_ID });
assert(true, "운영 identity 허용");
throws(() => assertNeonIdentity({ database: "neondb", endpoint: "ep-odd-voice-aokrqp5t", branch: "n/a" }), "Preview endpoint identity 차단", /Preview/);
throws(() => assertNeonIdentity({ database: "neondb", endpoint: "ep-other-x", branch: EXPECTED_BRANCH_ID }), "다른 endpoint identity 차단");
throws(() => assertNeonIdentity({ database: "neondb", endpoint: EXPECTED_ENDPOINT_ID, branch: "br-old-sound-aox78qdh" }), "다른 branch(백업 등) 차단");
throws(() => assertNeonIdentity({ database: "postgres", endpoint: EXPECTED_ENDPOINT_ID, branch: EXPECTED_BRANCH_ID }), "다른 database 차단");

// ── SQL 감사·checksum ─────────────────────────────────────────
console.log("== migration.sql ==");
const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");
auditCommunityMigrationSql(sql);
assert(true, "실제 migration.sql 감사 통과 (additive)");
assert(migrationChecksum(ROOT, MIGRATION_NAME) === PINNED_TARGET_SHA256, "실제 파일 checksum = 고정값");
assertPinnedTargetChecksum(PINNED_TARGET_SHA256);
throws(() => assertPinnedTargetChecksum("0".repeat(64)), "checksum 불일치 차단", /pinned/);
throws(() => auditCommunityMigrationSql(sql + '\nDROP TABLE "FreeBoardPost";'), "DROP 추가 차단");
throws(() => auditCommunityMigrationSql(sql + '\nALTER TABLE "FreeBoardPost" ADD COLUMN "x" TEXT;'), "기존 테이블 ALTER 차단");
throws(() => auditCommunityMigrationSql(sql + '\nALTER TABLE "User" ADD COLUMN "x" TEXT;'), "User ALTER 차단");
throws(() => auditCommunityMigrationSql(sql + '\nDELETE FROM "Comment";'), "DELETE FROM 차단");
throws(() => auditCommunityMigrationSql(sql + '\nUPDATE "CommentThread" SET "targetType"=\'COMMUNITY_POST\';'), "재분류 UPDATE 차단");
throws(() => auditCommunityMigrationSql(sql + '\nINSERT INTO "CommunityPost" VALUES (1);'), "INSERT(seed) 차단");
throws(() => auditCommunityMigrationSql(sql + "\nALTER TYPE \"EmploymentStatus\" ADD VALUE 'X';"), "다른 enum 변경 차단");
throws(() => auditCommunityMigrationSql(sql.replace(/ON DELETE CASCADE/, "ON DELETE SET NULL")), "FK 규칙 변경 차단");
throws(() => auditCommunityMigrationSql(sql.replace(/CREATE TABLE "CommunityPhoto"/, 'CREATE TABLE "Other"')), "테이블 누락 차단");

// ── 판정 (mock 상태) ─────────────────────────────────────────
console.log("== decision ==");
const repo = listRepoMigrations(path.join(ROOT, "prisma", "migrations"));
const sums = repoChecksums(ROOT, repo);
const before = repo.filter((m) => m !== MIGRATION_NAME);
const t0 = new Date("2026-11-01T00:00:00Z");
const rowsFor = (names: string[], over: Partial<Record<string, Partial<AppliedRow>>> = {}): AppliedRow[] =>
  names.map((n) => ({ migration_name: n, checksum: sums[n], finished_at: t0, rolled_back_at: null, ...(over[n] ?? {}) }));
const emptyProbe: SchemaProbe = { tables: ["User", "Caddy"], enumTypeExists: false, enumValueExists: false, indexes: [], fks: {}, rowCounts: {} };
const decide = (rows: AppliedRow[], statusPending: string[], probe = emptyProbe, r = repo, s = sums) =>
  decideCommunityMigration({ gate: gateSingleMigration, repo: r, repoSums: s, state: summarizeMigrationRows(rows), statusPending, probe });

assert(repo.includes(MIGRATION_NAME) && repo[repo.length - 1] === MIGRATION_NAME, "대상이 repo 마지막 migration");
assert(decide(rowsFor(before), [MIGRATION_NAME]).action === "ready", "대기 = 대상 1개 → ready");
const d0 = decide(rowsFor(repo), []);
assert(d0.action === "already-applied", "대기 0개(이미 적용) → deploy 안 함");
assert(decide(rowsFor(before.slice(0, -1)), [before[before.length - 1], MIGRATION_NAME]).action === "hold", "대기 2개 → hold");
assert(decide(rowsFor(before.slice(0, -1).concat(MIGRATION_NAME)), [before[before.length - 1]]).action === "hold", "다른 migration 1개 대기 → hold");
assert(decide(rowsFor(before), []).action === "hold", "repo 대기 1개인데 status 대기 0 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME, "20261121000000_other"]).action === "hold", "status 에 추가 대기 → hold");
assert(decide(rowsFor(before, { [before[3]]: { finished_at: null } }), [MIGRATION_NAME]).action === "hold", "실패(finished_at null) 기록 → hold");
assert(decide(rowsFor(before, { [before[3]]: { rolled_back_at: t0 } }), [MIGRATION_NAME]).action === "hold", "롤백 기록 → hold");
assert(
  decide([...rowsFor(before), { migration_name: before[5], checksum: sums[before[5]], finished_at: t0, rolled_back_at: null }], [MIGRATION_NAME]).action === "hold",
  "중복 기록 → hold"
);
assert(
  decide([...rowsFor(before), { migration_name: MIGRATION_NAME, checksum: "x", finished_at: null, rolled_back_at: null }], [MIGRATION_NAME]).action === "hold",
  "대상 실패 기록 남아 있음 → hold"
);
assert(
  decide([...rowsFor(before), { migration_name: "20261119000000_unknown", checksum: "x", finished_at: t0, rolled_back_at: null }], [MIGRATION_NAME]).action === "hold",
  "DB에는 있는데 repo 파일 없음 → hold"
);
assert(decide(rowsFor(before, { [before[10]]: { checksum: "0".repeat(64) } }), [MIGRATION_NAME]).action === "hold", "기존 적용 migration checksum 불일치 → hold");
assert(decide(rowsFor(repo, { [MIGRATION_NAME]: { checksum: "0".repeat(64) } }), []).action === "hold", "대상 적용 checksum 불일치 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME], emptyProbe, repo, { ...sums, [MIGRATION_NAME]: "0".repeat(64) }).action === "hold", "로컬 대상 checksum ≠ 고정값 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME], emptyProbe, before).action === "hold", "repo 에 대상 없음 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME], { ...emptyProbe, tables: ["User", "CommunityPost"] }).action === "hold", "기록 없는데 테이블 존재 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME], { ...emptyProbe, enumValueExists: true }).action === "hold", "기록 없는데 enum 값 존재 → hold");
assert(decide(rowsFor(before), [MIGRATION_NAME], { ...emptyProbe, enumTypeExists: true }).action === "hold", "기록 없는데 enum 타입 존재 → hold");
assert(decide([], [MIGRATION_NAME]).action === "hold", "_prisma_migrations 비어 있음(대기 다수) → hold");

console.log("== prisma status parser ==");
const statusOut = `67 migrations found in prisma/migrations\nFollowing migration have not yet been applied:\n${MIGRATION_NAME}\n\nTo apply migrations in production run prisma migrate deploy.`;
assert(JSON.stringify(parsePrismaMigrateStatusPending(statusOut)) === JSON.stringify([MIGRATION_NAME]), "status 대기 1개 파싱");
assert(parsePrismaMigrateStatusPending("Database schema is up to date!").length === 0, "status 최신 파싱");

console.log("== after-schema / fingerprints ==");
const okProbe: SchemaProbe = {
  tables: ["CommunityPost", "CommunityPhoto"],
  enumTypeExists: true,
  enumValueExists: true,
  indexes: [
    "CommunityPost_pkey",
    "CommunityPhoto_pkey",
    "CommunityPost_boardType_deletedAt_createdAt_idx",
    "CommunityPost_authorUserId_idx",
    "CommunityPhoto_storageKey_key",
    "CommunityPhoto_postId_sortOrder_idx",
  ],
  fks: { CommunityPost_authorUserId_fkey: "RESTRICT", CommunityPhoto_postId_fkey: "CASCADE" },
  rowCounts: { CommunityPost: 0, CommunityPhoto: 0 },
};
assertCommunitySchemaAfter(okProbe, { requireEmpty: true });
assert(true, "적용 후 스키마 정상");
throws(() => assertCommunitySchemaAfter({ ...okProbe, enumValueExists: false }, { requireEmpty: true }), "enum 값 없음 차단");
throws(() => assertCommunitySchemaAfter({ ...okProbe, indexes: okProbe.indexes.slice(1) }, { requireEmpty: true }), "인덱스 누락 차단");
throws(() => assertCommunitySchemaAfter({ ...okProbe, fks: { ...okProbe.fks, CommunityPhoto_postId_fkey: "NO ACTION" } }, { requireEmpty: true }), "FK 규칙 다름 차단");
throws(() => assertCommunitySchemaAfter({ ...okProbe, rowCounts: { CommunityPost: 1, CommunityPhoto: 0 } }, { requireEmpty: true }), "적용 직후 행 존재 차단");
const fpA = { User: { total: 3, fingerprint: "a" }, Comment: { total: 5, fingerprint: "b" } };
assert(compareFingerprints(fpA, { ...fpA }).length === 0, "지문 동일 → 통과");
assert(compareFingerprints(fpA, { ...fpA, Comment: { total: 4, fingerprint: "b" } }).includes("Comment"), "행 수 변경 감지");
assert(compareFingerprints(fpA, { ...fpA, User: { total: 3, fingerprint: "z" } }).includes("User"), "지문 변경 감지");
assert(compareFingerprints(fpA, { User: fpA.User } as typeof fpA).includes("Comment"), "지문 누락 감지");

console.log("== prisma command allowlist ==");
assert(allowedPrismaArgs(["migrate", "status"]), "migrate status 허용");
assert(allowedPrismaArgs(["migrate", "deploy"]), "migrate deploy 허용");
for (const bad of [["migrate", "reset"], ["migrate", "dev"], ["migrate", "resolve"], ["db", "push"], ["db", "seed"], ["migrate", "deploy", "--force"], ["migrate"]]) {
  assert(!allowedPrismaArgs(bad), `거부: prisma ${bad.join(" ")}`);
}

// ── 정적 검사: 스크립트·workflow ─────────────────────────────────
console.log("== static: deploy script ==");
const script = fs.readFileSync(path.join(ROOT, "scripts/maintenance/deploy-community-free-board-migration.ts"), "utf8");
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
assert(!/migrate\s*",\s*"(reset|dev|resolve)|db push|--force|--accept-data-loss/.test(code), "reset/dev/resolve/db push/--force 없음");
assert((code.match(/runPrisma\(url, \["migrate", "deploy"\]\)/g) || []).length === 1, "migrate deploy 호출 1곳");
assert(!/for\s*\(|while\s*\(/.test(code.slice(code.indexOf('runPrisma(url, ["migrate", "deploy"])') - 200, code.indexOf('runPrisma(url, ["migrate", "deploy"])'))), "deploy 재시도 루프 없음");
assert(/SET TRANSACTION READ ONLY/.test(code), "점검 조회는 READ ONLY 트랜잭션");
assert(/requireProdMaintenance\(TASK_IDS\[mode\]\)/.test(code), "모드별 task id 로 운영 escape hatch");
assert(code.indexOf("resolveModeAndConfirm(") < code.indexOf("new PrismaClient("), "DB 연결 전에 모드·문구 검증");
assert(code.indexOf('if (mode === "precheck")') < code.indexOf('runPrisma(url, ["migrate", "deploy"])'), "precheck 는 deploy 전에 반환");
assert(!/console\.(log|error)\([^)]*\burl\b/.test(code), "URL 출력 없음");

console.log("== static: workflow ==");
const wfRaw = fs.readFileSync(path.join(ROOT, ".github/workflows/prod-db-community-free-board.yml"), "utf8");
const wf = wfRaw.replace(/^\s*#.*$/gm, "");
assert(/^on:\n  workflow_dispatch:/m.test(wfRaw), "workflow_dispatch 전용");
assert(!/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m.test(wf), "자동 트리거 없음");
const secretRefs = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
assert(secretRefs.length === 1 && secretRefs[0] === "PRODUCTION_DATABASE_URL", "secret 은 PRODUCTION_DATABASE_URL 하나만");
assert(!/secrets\.DATABASE_URL\b|secrets\.PREVIEW_|secrets\[/.test(wf), "공용 DATABASE_URL·Preview·동적 secret 참조 없음");
assert(/permissions:\n  contents: read/.test(wf), "기본 권한 contents: read");
assert(!/contents: write|id-token: write|actions: write/.test(wf), "쓰기 권한 없음");
assert(/concurrency:\n  group: prod-db-community-free-board-v1\n  cancel-in-progress: false/.test(wf), "concurrency 고정");
assert(/environment: production-db/.test(wf), "environment production-db 사용");
const guardJob = wf.slice(wf.indexOf("  guard:"), wf.indexOf("  prod-db:"));
assert(!/environment:/.test(guardJob), "guard job 은 environment 미참조 (자동 생성 방지)");
assert(/environments\/production-db/.test(guardJob) && /required_reviewers/.test(guardJob) && /jh9716/.test(guardJob), "guard: production-db 보호 규칙(jh9716) 확인");
assert(/needs: guard/.test(wf), "DB job 은 guard 통과 후에만");
assert(/expected="PROD-DB-\$\{upper\} morning-tooth-60659454 20261120160000_community_free_board_v1"/.test(wf), "모드별 확인 문구");
assert(/main\) ;;\n\s+prod-db-migrate-community-free-board-20261121\) ;;/.test(wf) && !/ref[^\n]*\*\)/.test(wf.replace(/\*\) echo "ref not allowed"/, "")), "ref 허용목록 정확 일치 (와일드카드 없음)");
assert(/ACTOR" != "jh9716"/.test(wf), "dispatch 사용자 jh9716 만");
assert(/pitr_confirmed=YES/.test(wf) && /backup-pre-pr380-prod-20\[0-9\]\{6\}/.test(wf), "migrate: PITR·백업 브랜치 입력 필수");
assert(!/migrate reset|db push|--force|--accept-data-loss|migrate dev|migrate resolve|db seed/.test(wf), "reset/push/resolve/seed 없음");
assert(!/continue-on-error|uses:\s*\S*retry/i.test(wf), "재시도 action·continue-on-error 없음");
assert(/persist-credentials: false/.test(wf), "checkout 자격 증명 비보존");
assert(!/(echo|printf)[^\n]*\$\{?DATABASE_URL\b/.test(wf), "URL echo 없음");
assert(!/vercel/i.test(wf), "Vercel 단계 없음");

console.log("== static: local tsx only (no dynamic download) ==");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const tsxPin = pkg.devDependencies?.tsx;
assert(tsxPin === "4.23.15", "package.json devDependencies.tsx 정확 고정 4.23.15 (^/~ 없음)");
assert(!pkg.dependencies?.tsx, "tsx 는 dependencies 가 아닌 devDependencies 에만");
assert(lock.packages?.[""]?.devDependencies?.tsx === tsxPin, "lock 루트 devDependencies.tsx == package.json");
assert(lock.packages?.["node_modules/tsx"]?.version === tsxPin && /^sha512-/.test(lock.packages?.["node_modules/tsx"]?.integrity ?? ""), "lock node_modules/tsx 버전·integrity 고정");
assert(!/\bnpx\b/.test(wf), "workflow 에 npx 없음 (동적 설치 경로 없음)");
assert(!/npm (install|i|exec|x)\b|\bpnpm\b|\byarn\b|\bbunx?\b/.test(wf), "workflow 설치는 npm ci 만");
assert((wf.match(/run: npm ci --no-audit --no-fund/g) || []).length === 1, "npm ci (lock 고정) 1회");
assert(/test -x node_modules\/\.bin\/tsx/.test(wf), "실행 전 로컬 tsx 존재 검사");
assert(/\[ "\$want" = "4\.23\.15" \] && \[ "\$got" = "\$want" \]/.test(wf), "로컬 tsx 버전 == 고정 버전 검사");
const runIdx = wf.indexOf("./node_modules/.bin/tsx scripts/maintenance/deploy-community-free-board-migration.ts");
assert(runIdx > 0 && wf.indexOf("Verify pinned local tsx") < runIdx && wf.indexOf("Verify pinned local tsx") > wf.indexOf("run: npm ci"), "npm ci → 버전 검사 → 로컬 tsx 로 스크립트 실행 순서");
const verifyStep = wf.slice(wf.indexOf("Verify pinned local tsx"), wf.indexOf("- name: Run guarded script"));
assert(!/secrets\./.test(verifyStep), "tsx 검사 단계에는 운영 secret 없음");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
