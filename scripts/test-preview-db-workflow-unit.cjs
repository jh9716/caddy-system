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
// migrations 60
const migs = fs.readdirSync(path.join(__dirname, "..", "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory());
t(migs.length === 60, "prisma/migrations 60개");
// seed 에 실데이터 패턴 없음
const seed = fs.readFileSync(path.join(__dirname, "preview-db", "seed-preview.cjs"), "utf8");
t(!/@[a-z0-9-]+\.(com|kr|net)|010-?\d{4}/i.test(seed), "seed 에 이메일/전화번호 없음");
t(/validatePreviewDbUrl/.test(seed), "seed 도 URL 검증 사용");

console.log(`${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
