/**
 * VERTHILL Preview 전용 합성(synthetic) seed. 운영 데이터 없음.
 * 실행 조건(모두 충족해야 함):
 *   DATABASE_URL 이 validate-url.cjs 검증 통과 (Preview endpoint 정확 일치, direct, neondb, sslmode=require)
 *   PREVIEW_DB_CONFIRM=lucky-mode-29989630
 *   PREVIEW_SEED_PASSWORD=<테스트 계정 공통 비밀번호, 12자 이상>  (출력하지 않음)
 *   VERCEL_ENV != production
 * 빈 DB 여부(사용자·캐디·월표 0)는 workflow 의 state.cjs seed-gate 가 먼저 확인한다 (refuse-by-default).
 * 사용: 저장소 루트에서  TZ=UTC node scripts/preview-db/seed-preview.cjs
 */
"use strict";
const path = require("node:path");
const repo = process.env.REPO_DIR || process.cwd();
const req = (m) => require(require.resolve(m, { paths: [repo] }));

const PREVIEW_PROJECT_ID = "lucky-mode-29989630";
function die(msg) { console.error("⛔ seed-preview 중단: " + msg); process.exit(2); }

// ---------- guard ----------
const { validatePreviewDbUrl } = require("./validate-url.cjs");
const localHarness = process.argv.includes("--local-harness");
if (localHarness && process.env.GITHUB_ACTIONS === "true") die("--local-harness 는 Actions 에서 금지");
const v = validatePreviewDbUrl(process.env.DATABASE_URL || "", { localHarness });
if (!v.ok) die("DATABASE_URL 검증 실패 (" + v.reason + ")");
if (process.env.PREVIEW_DB_CONFIRM !== PREVIEW_PROJECT_ID) die("PREVIEW_DB_CONFIRM 이 Preview 프로젝트 id 와 다름");
if ((process.env.VERCEL_ENV || "") === "production") die("VERCEL_ENV=production");
if (process.env.NODE_ENV === "production" && process.env.VERCEL === "1") die("Vercel production runtime");
const pw = process.env.PREVIEW_SEED_PASSWORD;
if (!pw || pw.length < 12) die("PREVIEW_SEED_PASSWORD 없음 또는 12자 미만");

const { PrismaClient } = req("@prisma/client");
const bcrypt = req("bcryptjs");
const prisma = new PrismaClient();
const d = (ymd) => new Date(`${ymd}T00:00:00`); // 앱과 동일 (로컬 자정). TZ=UTC 로 실행 권장
const pad = (n) => String(n).padStart(2, "0");

async function main() {
  // 데이터 가드: 테스트 접두어가 아닌 User/Caddy 가 있으면 중단 (운영 데이터 혼입 방지)
  const foreignUsers = await prisma.user.count({ where: { NOT: { username: { startsWith: "테스트" } } } });
  const foreignCaddies = await prisma.caddy.count({ where: { NOT: { name: { startsWith: "테스트" } } } });
  if (foreignUsers || foreignCaddies) die(`비테스트 데이터 존재 (user=${foreignUsers}, caddy=${foreignCaddies})`);

  const hash = await bcrypt.hash(pw, 10); // src/lib/userPassword.ts 와 동일 (bcryptjs, rounds 10)

  // Caddy: 마샬 27 + 일반 캐디 3
  const caddyIds = [];
  for (let i = 1; i <= 30; i++) {
    const marshal = i <= 27;
    const code = marshal ? `TEST-M${pad(i)}` : `TEST-C${pad(i - 27)}`;
    const name = marshal ? `테스트마샬${pad(i)}` : `테스트캐디${pad(i - 27)}`;
    const c = await prisma.caddy.upsert({
      where: { employeeCode: code },
      update: { name },
      create: { employeeCode: code, name, team: `${((i - 1) % 9) + 1}조`, teamOrder: i, memo: "PREVIEW SEED" },
    });
    caddyIds.push(c.id);
  }
  // MarshalProfile 27
  const profiles = [];
  for (let i = 0; i < 27; i++) {
    const p = await prisma.marshalProfile.upsert({
      where: { caddyId: caddyIds[i] },
      update: {},
      create: { caddyId: caddyIds[i], active: true, startedOn: d("2026-01-01"), rotationOrder: i + 1 },
    });
    profiles.push(p);
  }
  // Users: admin / leader / caddy
  const users = [
    { username: "테스트관리자", role: "admin" },
    { username: "테스트조장", role: "leader", managedTeams: ["1조"] },
    { username: "테스트캐디01", role: "caddy", caddyId: caddyIds[27] },
    { username: "테스트캐디02", role: "caddy", caddyId: caddyIds[28] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: { password: hash, role: u.role },
      create: { ...u, password: hash },
    });
  }

  // Plans: 2026-10 FINALIZED, 2026-11 DRAFT, 2026-12 = 월표 없음
  async function plan(year, month, status) {
    const ex = await prisma.marshalMonthPlan.findUnique({ where: { year_month: { year, month } } });
    if (ex) return { plan: ex, created: false };
    const p = await prisma.marshalMonthPlan.create({
      data: { year, month, status, startRotationOrder: 1, nextRotationOrder: 1, generatedAt: new Date() },
    });
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let k = 0;
    const rows = [];
    for (let day = 1; day <= days; day++) {
      const date = d(`${year}-${pad(month)}-${pad(day)}`);
      for (const [shift, n] of [["AM", 2], ["PM", 1]]) {
        for (let s = 0; s < n; s++) {
          const pr = profiles[k % 27]; k++;
          rows.push({ planId: p.id, date, shift, slotIndex: s, caddyId: pr.caddyId, marshalProfileId: pr.id, source: "ROTATION" });
        }
      }
    }
    await prisma.marshalMonthSlot.createMany({ data: rows });
    const next = (k % 27) + 1;
    await prisma.marshalMonthPlan.update({ where: { id: p.id }, data: { nextRotationOrder: next } });
    return { plan: p, created: true };
  }
  await plan(2026, 10, "FINALIZED");
  await plan(2026, 11, "DRAFT");

  // 벌당 발생 2건 (OPEN, 12월 대상) + 대타 credit 1건 — idempotencyKey/조회로 멱등
  for (const [i, key] of [[2, "preview-seed-occ-1"], [5, "preview-seed-occ-2"]]) {
    await prisma.marshalPenaltyOccurrence.upsert({
      where: { idempotencyKey: key },
      update: {},
      create: { idempotencyKey: key, caddyId: profiles[i].caddyId, marshalProfileId: profiles[i].id,
        occurredOn: d("2026-11-05"), targetYear: 2026, targetMonth: 12, status: "OPEN", reason: "테스트 벌당", note: "PREVIEW SEED" },
    });
  }
  const cr = await prisma.marshalRotationCredit.findFirst({ where: { note: "PREVIEW SEED" } });
  if (!cr) await prisma.marshalRotationCredit.create({
    data: { marshalProfileId: profiles[7].id, status: "OPEN", sourceDate: d("2026-10-15"), replacedCaddyId: profiles[8].caddyId, reason: "테스트 대타", note: "PREVIEW SEED" },
  });

  const counts = {
    caddy: await prisma.caddy.count(), user: await prisma.user.count(),
    marshalProfile: await prisma.marshalProfile.count(), plan: await prisma.marshalMonthPlan.count(),
    slot: await prisma.marshalMonthSlot.count(), occurrence: await prisma.marshalPenaltyOccurrence.count(),
    credit: await prisma.marshalRotationCredit.count(),
  };
  console.log("[seed-preview] 완료 counts=" + JSON.stringify(counts));
}
main().catch((e) => { console.error("[seed-preview] 실패: " + (e && e.message ? e.message.split("\n")[0] : e)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
