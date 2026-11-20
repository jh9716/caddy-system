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
// ── PR #380 자유게시판 V1 전용 Preview gate ──
{
  const G = require("./maintenance/single-migration-gate.cjs");
  const {
    gateCommunityFreeBoardPreviewMigrate: gate,
    gateCommentRepliesPreviewMigrate: repliesGate,
    isCommunityFreeBoardPreviewBranch: isCm,
    COMMUNITY_FREE_BOARD_MIGRATION: CT,
    COMMUNITY_FREE_BOARD_MIGRATION_SHA256: CSHA,
    COMMUNITY_FREE_BOARD_BRANCH: CB,
    PREVIEW_PROJECT_ID: PID,
    PREVIEW_NEON_ENDPOINT: PEP,
  } = G;
  const { repoMigrationChecksums } = require("./preview-db/migration-state.cjs");
  const migDir = path.join(__dirname, "..", "prisma", "migrations");
  t(CT === "20261120160000_community_free_board_v1", "community 대상 migration 이름 고정");
  t(CSHA === "b284927f596d25861baefe4ab2859e50307996e22c3585dd467344883a756a4f", "community 대상 SHA-256 고정");
  t(CB === "preview-db-pr380-community-free-board", "community 브랜치 이름 고정");
  t(isCm("preview-db-pr380-community-free-board"), "community 전용 브랜치 정확히 일치");
  t(!isCm("preview-db-pr380-community-free-board-x"), "접미사 붙은 브랜치 거부 (정확 일치만)");
  t(!isCm("freeboard-v1-20261120"), "제품 브랜치는 community gate 아님");
  t(!isCm("main") && !isCm("preview-db-free-board-v1") && !isCm(""), "main·다른 preview-db·빈 이름 거부");
  // 실제 repo 기반 입력 (67개 = 66 + 대상)
  const repo67 = listRepoMigrations(migDir);
  t(repo67.length === 67 && repo67[66] === CT, "repo 67개, 마지막이 대상");
  const sums = repoMigrationChecksums(migDir, repo67);
  t(sums[CT] === CSHA, "repo 대상 migration.sql SHA-256 = 고정값");
  t(sums["20261031220000_free_board_v1"] && /^[0-9a-f]{64}$/.test(sums["20261031220000_free_board_v1"]), "repo checksum 계산 (sha256 hex)");
  const applied66 = repo67.slice(0, 66);
  const db66 = Object.fromEntries(applied66.map((m) => [m, sums[m]]));
  const cBase = {
    refName: CB,
    previewProjectId: PID,
    neonEndpoint: PEP,
    repo: repo67,
    appliedFinished: applied66,
    failedNames: [],
    statusPending: [CT],
    repoChecksums: sums,
    appliedChecksums: db66,
  };
  const ok = gate(cBase);
  t(ok.action === "allow", "PASS: 66 적용·checksum 일치·대상 1개 pending → allow");
  const H = (over, name) => {
    const r = gate({ ...cBase, ...over });
    t(r.action === "hold" && typeof r.reason === "string" && r.reason.length > 0, `HOLD: ${name} (${r.reason})`); if (process.env.SHOW_REASONS) console.log(`  HOLD ${name} → ${r.reason}`);
  };
  H({ appliedFinished: repo67, appliedChecksums: { ...db66, [CT]: CSHA }, statusPending: [] }, "pending 0개 (이미 적용)");
  const extra = "20261121000000_other_v1";
  H({ repo: [...repo67, extra], statusPending: [CT, extra], repoChecksums: { ...sums, [extra]: "a".repeat(64) } }, "pending 2개");
  H({ statusPending: [CT, extra] }, "prisma status 에 다른 pending");
  H({ appliedFinished: applied66.slice(0, 65), appliedChecksums: Object.fromEntries(applied66.slice(0, 65).map((m) => [m, sums[m]])), statusPending: [applied66[65], CT] }, "기존 66개 중 1개 미적용 (pending 2개)");
  const wrong = "20261120160000_community_free_board_v2";
  H({ repo: [...applied66, wrong], statusPending: [wrong], repoChecksums: { ...sums, [wrong]: CSHA } }, "대상 이름 다름");
  H({ repoChecksums: { ...sums, [CT]: "0".repeat(64) } }, "대상 SQL sha 불일치");
  H({ repoChecksums: { ...sums, [CT]: undefined } }, "대상 SQL sha 없음");
  H({ appliedChecksums: { ...db66, [applied66[10]]: "f".repeat(64) } }, "기존 migration checksum 불일치");
  H({ appliedChecksums: Object.fromEntries(applied66.slice(1).map((m) => [m, sums[m]])) }, "기존 migration checksum 누락");
  H({ failedNames: ["20261117233000_team_affiliation_settings"] }, "실패(finished_at NULL) 행");
  H({ failedNames: ["20261031220000_free_board_v1"] }, "rolled-back 행");
  const unk = "20269999999999_unknown";
  H({ appliedFinished: [...applied66, unk], appliedChecksums: { ...db66, [unk]: "b".repeat(64) } }, "unknown 적용 행");
  H({ appliedFinished: [...applied66.slice(0, 65), applied66[0]] }, "중복 적용 행");
  H({ appliedFinished: [...applied66.slice(0, 65), unk], appliedChecksums: { ...db66, [unk]: "b".repeat(64) }, statusPending: [applied66[65], CT] }, "unknown 적용 행 (개수는 66 그대로)");
  H({ dbError: "psql failed" }, "DB 조회 오류");
  H({ dbErrorAgain: "connection reset" }, "재조회 중 DB 오류");
  H({ appliedFinished: null }, "입력 누락 (fail-closed)");
  H({ appliedChecksums: null }, "DB checksum 정보 없음 (fail-closed)");
  H({ appliedFinishedAgain: repo67, appliedChecksumsAgain: { ...db66, [CT]: CSHA }, statusPendingAgain: [] }, "실행 직전 재조회 시 목록 바뀜");
  H({ appliedChecksumsAgain: { ...db66, [applied66[3]]: "c".repeat(64) } }, "실행 직전 재조회 시 checksum 바뀜");
  H({ repoChecksumsAgain: { ...sums, [CT]: "d".repeat(64) } }, "실행 직전 재조회 시 대상 SQL 바뀜");
  H({ previewProjectId: "morning-tooth-60659454" }, "운영 프로젝트 id");
  H({ previewProjectId: undefined }, "프로젝트 id 없음");
  H({ neonEndpoint: "ep-crimson-cell-a1i1tpce" }, "운영 endpoint");
  H({ neonEndpoint: "n/a" }, "endpoint 확인 불가 (정확 일치 필요)");
  H({ neonEndpoint: undefined }, "endpoint 없음");
  t(gate({ ...cBase, refName: "preview-db-comment-replies-8d28" }).action === "skip", "다른 preview-db 브랜치에서는 community gate 미적용");
  t(gate({ ...cBase, refName: "main" }).action === "skip", "main 에서는 community gate 미적용");
  t(repliesGate({ ...cBase, refName: CB }).action === "skip", "community 브랜치에서 댓글 gate 미적용");
  // extraCheck 예외도 HOLD
  const throwing = { ...cBase };
  Object.defineProperty(throwing, "repoChecksums", { get() { throw new Error("boom"); }, enumerable: true });
  t(gate(throwing).action === "hold", "HOLD: 내부 예외 (fail-closed)");
  // 기존 댓글 gate 동작 유지
  const target = "20261109193000_comment_replies_v1";
  const rRepo = ["20260919070000_comment_v1", target];
  const rBase = { refName: "preview-db-comment-replies-8d28", previewProjectId: PID, neonEndpoint: PEP, repo: rRepo, appliedFinished: [rRepo[0]], failedNames: [], statusPending: [target] };
  t(repliesGate(rBase).action === "allow", "댓글 gate 기존 동작 유지 (allow)");
  t(repliesGate({ ...rBase, neonEndpoint: "n/a" }).action === "allow", "댓글 gate 기존 동작 유지 (n/a 허용 그대로)");
}
const communitySnapSql = fs.readFileSync(path.join(__dirname, "preview-db", "community-snapshot-readonly.sql"), "utf8");
const communityVerifySql = fs.readFileSync(path.join(__dirname, "preview-db", "community-verify-readonly.sql"), "utf8");
for (const [name, sql] of [["snapshot", communitySnapSql], ["verify", communityVerifySql]]) {
  t(/BEGIN TRANSACTION READ ONLY/.test(sql) && /ROLLBACK;\s*$/.test(sql), `community ${name} SQL 읽기 전용`);
  t(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i.test(sql.replace(/^--.*$/gm, "")), `community ${name} SQL 쓰기 구문 없음`);
  t(!/"(body|title|username|password|name|storageKey)"/.test(sql), `community ${name} SQL 본문·개인정보 컬럼 직접 출력 없음`);
}
for (const tbl of ["User", "Caddy", "Comment", "CommentThread", "FreeBoardPost", "FreeBoardPhoto"]) {
  t(new RegExp(`FROM "${tbl}"`).test(communitySnapSql), `community 지문에 ${tbl} 포함`);
}
t(/CommunityPost_authorUserId_fkey/.test(communityVerifySql) && /CommunityPhoto_postId_fkey/.test(communityVerifySql), "community verify FK 2개");
t(/COMMUNITY_POST/.test(communityVerifySql) && /CommunityBoardType/.test(communityVerifySql), "community verify enum 값");
t(/20261120160000_community_free_board_v1/.test(communityVerifySql), "community verify migration 기록");
t(/gateCommunityFreeBoardPreviewMigrate/.test(stateSrc), "state.cjs community gate 사용");
t(/isCommunityFreeBoardPreviewBranch\(refName\)/.test(stateSrc), "state.cjs migrate-gate 에서 community 브랜치 판별");
t(/PARTIALLY_MIGRATED \(state/.test(stateSrc), "state.cjs community: PARTIALLY_MIGRATED 만 허용");
t(/repoMigrationChecksums\(migDir, repoAgain\)/.test(stateSrc), "state.cjs community: 실행 직전 repo checksum 재계산");
t(/existing data changed across migrate/.test(stateSrc), "state.cjs community: migrate 전후 지문 비교");
t(/CommunityPost must be empty after migrate/.test(stateSrc) && /CommunityPhoto must be empty after migrate/.test(stateSrc), "state.cjs community: 새 테이블 0행 검증");
t(/community_free_board_v1 checksum mismatch/.test(stateSrc), "state.cjs community: 적용 후 checksum 검증");
t(/cannot write community before-snapshot/.test(stateSrc), "state.cjs community: 지문 저장 실패 시 HOLD");
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
