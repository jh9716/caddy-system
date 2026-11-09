// Preview DB workflow 단위 테스트: URL 검증 매트릭스 + workflow 정적 검사. 네트워크·DB 접근 없음.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { validatePreviewDbUrl } = require("./preview-db/validate-url.cjs");

let pass = 0, failN = 0;
const t = (ok, name) => { if (ok) pass++; else { failN++; console.log("  ✗ " + name); } };
const H = "ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech";
const good = `postgresql://u_test:pw_test@${H}/neondb?sslmode=require`;
const cases = [
  [good, true, "정상"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=require&channel_binding=require`, true, "정상 + channel_binding"],
  [`postgres://u_test:pw_test@${H}:5432/neondb?sslmode=require`, true, "postgres: 스킴 + 5432"],
  [`postgresql://u_test:pw_test@ep-odd-voice-aokrqp5t-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`, false, "pooler host"],
  [`${good}&pgbouncer=true`, false, "pgbouncer param"],
  [`postgresql://u_test:pw_test@${H}/neondb2?sslmode=require`, false, "다른 DB"],
  [`postgresql://u_test:pw_test@${H}/postgres?sslmode=require`, false, "postgres DB"],
  [`postgresql://u_test:pw_test@${H}/?sslmode=require`, false, "DB 없음"],
  [`postgresql://u_test:pw_test@ep-other-host-abc123.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`, false, "다른 endpoint"],
  [`postgresql://u_test:pw_test@ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`, false, "운영 endpoint"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=require&options=endpoint%3Dep-crimson-cell-a1i1tpce`, false, "운영 endpoint를 options로"],
  [`postgresql://u_test:pw_test@${H}.evil.com/neondb?sslmode=require`, false, "호스트 뒤 도메인"],
  [`postgresql://u_test:pw_test@evil.${H}/neondb?sslmode=require`, false, "호스트 앞 도메인"],
  [`postgresql://u_test:pw_test@EP-ODD-VOICE-AOKRQP5T.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`, false, "대문자 호스트"],
  [`postgresql://u_test:pw_test@${H}./neondb?sslmode=require`, false, "끝 점"],
  [`postgresql://u_test:pw_test@${H}:6543/neondb?sslmode=require`, false, "다른 포트"],
  [`postgresql://${H}:pw@evil.com/neondb?sslmode=require`, false, "userinfo에 Preview 호스트 숨김"],
  [`postgresql://u:p@evil.com@${H}/neondb?sslmode=require`, false, "@ 두 개"],
  [`postgresql://u_test:pw_test@evil.com/${H}/neondb?sslmode=require`, false, "경로에 호스트 숨김"],
  [`postgresql://u_test:pw_test@evil.com/neondb?sslmode=require&host=${H}`, false, "host 쿼리 파라미터"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=require&host=evil.com`, false, "host 쿼리로 우회"],
  [`postgresql://u_test:pw_test@${H}/neondb`, false, "sslmode 없음"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=prefer`, false, "sslmode=prefer"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=disable`, false, "sslmode=disable"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=require&sslmode=disable`, false, "중복 파라미터"],
  [`postgresql://u_test:pw_test@${H}/neondb?sslmode=require#x`, false, "fragment"],
  [`postgresql://${H}/neondb?sslmode=require`, false, "자격 증명 없음"],
  [`mysql://u_test:pw_test@${H}/neondb?sslmode=require`, false, "다른 스킴"],
  [`postgresql://u_test:pw_test@127.0.0.1/neondb?sslmode=require`, false, "localhost (harness 아님)"],
  [` ${good}`, false, "앞 공백"],
  [`${good}\n`, false, "개행"],
  [``, false, "빈 값"],
  [`postgresql://u_test:pw_test@ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech%2Eevil.com/neondb?sslmode=require`, false, "퍼센트 인코딩 호스트"],
];
for (const [url, want, name] of cases) t(validatePreviewDbUrl(url).ok === want, `URL 매트릭스: ${name}`);
t(validatePreviewDbUrl("postgresql://a:b@127.0.0.1:5432/neondb", { localHarness: true }).ok, "local harness 허용(로컬만)");
t(!validatePreviewDbUrl(`postgresql://a:b@${H}.x/neondb`, { localHarness: true }).ok, "local harness 에서도 원격 거부");
// 실패 사유에 비밀값이 섞이지 않음
const r = validatePreviewDbUrl(`postgresql://SECRETUSER:SECRETPW@evil.com/neondb?sslmode=require`);
t(!r.ok && !JSON.stringify(r).includes("SECRET"), "실패 결과에 자격 증명 미포함");

// workflow 정적 검사
const wfRaw = fs.readFileSync(path.join(__dirname, "..", ".github/workflows/preview-db-build.yml"), "utf8");
const wf = wfRaw.replace(/^\s*#.*$/gm, ""); // 주석 제외
const secretRefs = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
t(secretRefs.length > 0 && secretRefs.every((s) => s === "PREVIEW_DATABASE_URL" || s === "PREVIEW_SEED_PASSWORD"), "workflow secrets 는 PREVIEW_DATABASE_URL(+seed 비밀번호)만");
t(!/secrets\.DATABASE_URL\b|secrets\.DIRECT_URL|secrets\[/.test(wf), "운영 DATABASE_URL/DIRECT_URL·동적 secrets 참조 없음");
t(!/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m.test(wf), "workflow_dispatch 외 트리거 없음");
t(/^on:\n  workflow_dispatch:/m.test(wfRaw), "workflow_dispatch 사용");
t(/permissions:\n  contents: read/.test(wf), "contents: read");
t(/concurrency:\n  group: preview-db-build-lucky-mode-29989630\n  cancel-in-progress: false/.test(wf), "concurrency 고정, 진행 중 취소 안 함");
t(/timeout-minutes: 20/.test(wf), "timeout");
t(/environment: preview-db/.test(wf), "GitHub Environment preview-db");
t(!/migrate reset|db push|--force|--accept-data-loss|migrate dev|--skip-generate/.test(wf), "reset/db push/--force 없음");
t(/prisma migrate deploy/.test(wf), "migrate deploy 사용");
t(!/vercel/i.test(wf.replace(/^#.*$/gm, "")), "Vercel 단계 없음");
t(!/(echo|printf)[^\n]*\$\{?(DATABASE_URL|PREVIEW_SEED_PASSWORD)\b/.test(wf), "URL/비밀번호 echo 없음");
// DB 접근 단계마다 validate-url 이 먼저
const steps = wf.split(/\n      - /);
for (const st of steps) {
  if (/secrets\.PREVIEW_DATABASE_URL/.test(st)) t(/node scripts\/preview-db\/validate-url\.cjs/.test(st), "DB 단계마다 URL 검증 선행: " + st.split("\n")[0].slice(0, 50));
}
// 확인 문구 모드별
t(/expected="PREVIEW-DB-\$\{upper\} lucky-mode-29989630"/.test(wf), "모드별 확인 문구");
// migrations: 하드코딩 없음 — repo 디렉터리에서 도출
const { listRepoMigrations, classifyMigrationState } = require("./preview-db/migration-state.cjs");
const repoMigs = listRepoMigrations(path.join(__dirname, "..", "prisma", "migrations"));
t(repoMigs.length >= 60, "repo migrations 도출 (>=60)");
t(repoMigs.includes("20261031220000_free_board_v1"), "free_board_v1 migration 포함");
const stateSrc = fs.readFileSync(path.join(__dirname, "preview-db", "state.cjs"), "utf8");
t(!/EXPECTED_MIGRATIONS\s*=\s*\d+/.test(stateSrc), "state.cjs 숫자 하드코딩 없음");
t(!/"60"|expected 60/.test(wf), "workflow 60 하드코딩 없음");
t(/migration-state\.cjs/.test(wf), "workflow 가 repo 도출 검사 사용");
t(/validatePreviewDbUrl\(url/.test(stateSrc) && /neondb/.test(stateSrc) && /read_only/.test(stateSrc), "state.cjs 격리 검증 유지");
const verifySql = fs.readFileSync(path.join(__dirname, "preview-db", "verify-readonly.sql"), "utf8");
t(/BEGIN TRANSACTION READ ONLY/.test(verifySql), "verify-readonly READ ONLY");
t(/comment_parentid_column/.test(verifySql), "verify parentId column exists");
t(/comment_parentid_nullable/.test(verifySql), "verify parentId nullable");
t(/Comment_parentId_fkey/.test(verifySql), "verify parentId FK name");
t(/delete_rule/.test(verifySql), "verify parentId FK delete_rule");
t(/comment_total=/.test(verifySql), "verify Comment 전체 건수");
t(/comment_parent_null=/.test(verifySql), "verify 기존 parentId NULL");
t(/comment_parent_set=/.test(verifySql), "verify parentId set count");
t(/comment_id_fingerprint=/.test(verifySql), "verify comment id fingerprint (no body)");
t(/20261109193000_comment_replies_v1/.test(verifySql), "verify replies migration finished");
t(!/"body"/.test(verifySql) && !/authorUserId/.test(verifySql), "verify SQL 댓글 본문·작성자 미출력");
t(/comment_parentid_nullable/.test(stateSrc) && /YES/.test(stateSrc), "state.cjs asserts parentId nullable");
t(/comment_parentid_fk_delete/.test(stateSrc) && /RESTRICT/.test(stateSrc), "state.cjs asserts FK RESTRICT");
t(/comment_id_fingerprint/.test(stateSrc), "state.cjs prints comment fingerprint for before/after");
t(/comment_total/.test(stateSrc), "state.cjs prints comment_total in precheck/verify");
t(repoMigs.includes("20261109193000_comment_replies_v1"), "comment_replies_v1 migration 포함");
{
  const { parsePrismaMigrateStatusPending, gateSingleMigration } = require("./maintenance/single-migration-gate.cjs");
  t(parsePrismaMigrateStatusPending("Database schema is up to date!").length === 0, "status parser up to date");
  const one = parsePrismaMigrateStatusPending(
    "Following migrations have not yet been applied:\n20261109193000_comment_replies_v1\n\nTo apply migrations in production run prisma migrate deploy.\n"
  );
  t(one.length === 1 && one[0] === "20261109193000_comment_replies_v1", "status parser one pending");
  const two = parsePrismaMigrateStatusPending(
    "Following migrations have not yet been applied:\n20261109193000_comment_replies_v1\n20261110000000_other_v1\n"
  );
  t(two.length === 2 && two[1] === "20261110000000_other_v1", "status parser extra pending");
  const target = "20261109193000_comment_replies_v1";
  const repo = ["20260919070000_comment_v1", target];
  t(
    gateSingleMigration({
      target,
      repo,
      appliedFinished: ["20260919070000_comment_v1"],
      failedNames: [],
      statusPending: [target],
    }).action === "deploy",
    "gate deploy when only replies pending"
  );
  t(
    gateSingleMigration({
      target,
      repo,
      appliedFinished: ["20260919070000_comment_v1"],
      failedNames: [],
      statusPending: [target, "20261110000000_other_v1"],
    }).action === "hold",
    "gate hold unexpected pending"
  );
  t(
    gateSingleMigration({
      target,
      repo,
      appliedFinished: repo,
      failedNames: [],
      statusPending: [],
    }).action === "already-applied",
    "gate already-applied"
  );
  t(
    gateSingleMigration({
      target,
      repo,
      appliedFinished: ["20260919070000_comment_v1"],
      failedNames: ["20260809101500_broken"],
      statusPending: [target],
    }).action === "hold",
    "gate hold failed migrations"
  );
  t(
    gateSingleMigration({
      target,
      repo,
      appliedFinished: ["20260919070000_comment_v1", "20269999999999_unknown"],
      failedNames: [],
      statusPending: [target],
    }).action === "hold",
    "gate hold unknown applied"
  );
  const {
    gateCommentRepliesPreviewMigrate,
    isCommentRepliesPreviewBranch,
    PREVIEW_PROJECT_ID,
    PREVIEW_NEON_ENDPOINT,
  } = require("./maintenance/single-migration-gate.cjs");
  t(isCommentRepliesPreviewBranch("preview-db-comment-replies-8d28"), "comment-replies branch matches");
  t(!isCommentRepliesPreviewBranch("preview-db-free-board-v1"), "other preview-db branch is not comment-replies");
  t(!isCommentRepliesPreviewBranch("main"), "main is not comment-replies");
  const repliesRepo = ["20260919070000_comment_v1", target];
  const repliesBase = {
    refName: "preview-db-comment-replies-8d28",
    previewProjectId: PREVIEW_PROJECT_ID,
    neonEndpoint: PREVIEW_NEON_ENDPOINT,
    repo: repliesRepo,
    appliedFinished: ["20260919070000_comment_v1"],
    failedNames: [],
    statusPending: [target],
  };
  t(gateCommentRepliesPreviewMigrate(repliesBase).action === "allow", "대상 migration 1개 → PASS");
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      statusPending: [target, "20261110000000_other_v1"],
      repo: [...repliesRepo, "20261110000000_other_v1"],
    }).action === "hold",
    "다른 pending 추가 → HOLD"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      appliedFinished: repliesRepo,
      statusPending: [],
    }).action === "hold",
    "pending 없음 → HOLD"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      failedNames: ["20260809101500_broken"],
    }).action === "hold",
    "failed 존재 → HOLD"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      appliedFinished: ["20260919070000_comment_v1", "20269999999999_unknown"],
    }).action === "hold",
    "unknown 존재 → HOLD"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      refName: "preview-db-free-board-v1",
      statusPending: [target, "20261110000000_other_v1"],
    }).action === "skip",
    "다른 브랜치에서 댓글 전용 조건 적용 방지"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      previewProjectId: "morning-tooth-60659454",
    }).action === "hold",
    "운영 프로젝트 id → HOLD"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      neonEndpoint: "ep-crimson-cell-a1i1tpce",
    }).action === "hold",
    "운영 DB 연결 시 차단"
  );
  t(
    gateCommentRepliesPreviewMigrate({
      ...repliesBase,
      appliedFinishedAgain: repliesRepo,
      statusPendingAgain: [],
    }).action === "hold",
    "실행 직전 목록이 바뀌면 HOLD"
  );
}
t(/gateCommentRepliesPreviewMigrate/.test(stateSrc), "state.cjs 댓글 migrate-gate 재사용");
t(/PREVIEW_REF_NAME/.test(wfRaw), "workflow 가 브랜치 이름을 migrate-gate 에 전달");
t((wfRaw.match(/state\.cjs migrate-gate/g) || []).length >= 2, "migrate 직전 migrate-gate 재조회");
const R = ["20260101000000_a", "20260102000000_b", "20260103000000_c"];
const base = { tables: 5, otherObjects: 0, hasPm: true, failed: 0, repo: R };
t(classifyMigrationState({ ...base, tables: 0, hasPm: false, applied: [] }).state === "EMPTY", "classify EMPTY");
t(classifyMigrationState({ ...base, hasPm: false, applied: [] }).state === "UNEXPECTED_NON_PRISMA", "classify non-prisma");
t(classifyMigrationState({ ...base, applied: R }).state === "MIGRATED", "classify MIGRATED (집합 일치)");
const part = classifyMigrationState({ ...base, applied: R.slice(0, 2) });
t(part.state === "PARTIALLY_MIGRATED" && part.missing.length === 1 && part.missing[0] === R[2], "classify PARTIAL + missing 이름");
t(classifyMigrationState({ ...base, applied: [...R.slice(0, 2), "20260109000000_zzz"] }).state === "UNEXPECTED_PRISMA_STATE", "같은 개수라도 이름 다르면 거부");
t(classifyMigrationState({ ...base, applied: [...R, "20260109000000_zzz"] }).state === "UNEXPECTED_PRISMA_STATE", "unknown 적용 거부");
t(classifyMigrationState({ ...base, applied: R, failed: 1 }).state === "UNEXPECTED_PRISMA_STATE", "failed 거부");
t(classifyMigrationState({ ...base, applied: [R[0], R[0], R[1]] }).state === "UNEXPECTED_PRISMA_STATE", "중복 적용 거부");
// 이전 60개 적용 DB + repo 61개 → PARTIAL (migrate 허용), 적용 후 MIGRATED (verify 통과)
const prev = repoMigs.filter((m) => m !== "20261031220000_free_board_v1");
t(classifyMigrationState({ ...base, applied: prev, repo: repoMigs }).state === "PARTIALLY_MIGRATED", "60 적용 DB → migrate 대상");
t(classifyMigrationState({ ...base, applied: repoMigs, repo: repoMigs }).state === "MIGRATED", "61 적용 후 MIGRATED");
{
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.mkdirSync(path.join(tmp, "20260101000000_ok"));
  fs.writeFileSync(path.join(tmp, "20260101000000_ok", "migration.sql"), "SELECT 1;");
  t(listRepoMigrations(tmp).length === 1, "listRepoMigrations ok");
  fs.mkdirSync(path.join(tmp, "20260102000000_nosql"));
  let threw = false;
  try { listRepoMigrations(tmp); } catch { threw = true; }
  t(threw, "migration.sql 누락 거부");
  fs.rmSync(tmp, { recursive: true, force: true });
}
// seed 에 실데이터 패턴 없음
const seed = fs.readFileSync(path.join(__dirname, "preview-db", "seed-preview.cjs"), "utf8");
t(!/@[a-z0-9-]+\.(com|kr|net)|010-?\d{4}/i.test(seed), "seed 에 이메일/전화번호 없음");
t(/validatePreviewDbUrl/.test(seed), "seed 도 URL 검증 사용");

console.log(`${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
