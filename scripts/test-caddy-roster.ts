/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ 운영 DB 실행 금지 — DO NOT RUN ON PRODUCTION DATABASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 이 스크립트는 실제 PostgreSQL/Neon DB에 직접 INSERT/UPDATE/DELETE 합니다.
 *
 * 【위험】 3단계 applyImportPayload() 호출 시 업로드 CSV에 없는 기존 캐디 전원(183명)
 *         에 missingFromImport=true 가 일괄 설정될 수 있습니다.
 *         cleanup(deleteMany)으로 이 플래그 변경을 되돌리지 못합니다.
 *
 * 【조건】 실행하려면 반드시:
 *         1. DATABASE_URL 이 운영 DB가 아닌 별도 테스트 DB를 가리킬 것
 *         2. ALLOW_DB_TEST=1 환경변수를 명시할 것
 *
 * 운영 DB 검증은 브라우저 /manage/caddies 또는 scripts/test-caddy-roster-unit.ts 를 사용하세요.
 * (DB 쓰기 없는 규칙 검증: scripts/test-caddy-roster-unit.ts)
 * ═══════════════════════════════════════════════════════════════════════════
 */

if (process.env.ALLOW_DB_TEST !== '1') {
  console.error(`
⛔ scripts/test-caddy-roster.ts 실행이 차단되었습니다.

이 스크립트는 운영 DB를 수정할 수 있어 기본적으로 실행할 수 없습니다.
DB 없는 단위 테스트: node --experimental-strip-types scripts/test-caddy-roster-unit.ts

테스트 DB에서만 실행하려면:
  ALLOW_DB_TEST=1 DATABASE_URL=<테스트DB_URL> node --experimental-strip-types scripts/test-caddy-roster.ts
`);
  process.exit(1);
}

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildImportPreview, parseImportFile, applyImportPayload } from '../lib/caddyImport';
import { assertLocalDatabaseUrl } from './assertLocalDatabaseUrl';

assertLocalDatabaseUrl(process.env.DATABASE_URL);
const prisma = new PrismaClient();

async function counts() {
  return {
    caddies: await prisma.caddy.count(),
    assignments: await prisma.assignment.count(),
    schedules: await prisma.schedule.count(),
    shiftDuties: await prisma.shiftDuty.count(),
  };
}

async function main() {
  const before = await counts();
  console.log('=== BEFORE ===', JSON.stringify(before));

  const sample = await prisma.caddy.findFirst({ orderBy: { id: 'asc' } });
  if (!sample) throw new Error('No caddies in DB');

  // 1) 신규 등록
  const created = await prisma.caddy.create({
    data: {
      name: '__TEST_ROSTER__',
      team: '9조',
      teamOrder: 1,
      employmentStatus: 'ACTIVE',
      employeeCode: 'TEST-ROSTER-001',
    },
  });
  console.log('[OK] create id=', created.id);

  // 2) 수정
  await prisma.caddy.update({
    where: { id: created.id },
    data: { team: '8조', teamOrder: 99, employmentStatus: 'LEAVE' },
  });
  console.log('[OK] update team/order/status');

  // 3) preview + apply (id match + new row)
  const csv = [
    'id,employeeCode,name,team,teamOrder,employmentStatus',
    `${created.id},TEST-ROSTER-001,__TEST_ROSTER__,8조,100,ACTIVE`,
    ',NEW-002,__TEST_NEW__,7조,1,ACTIVE',
  ].join('\n');
  const preview = buildImportPreview(parseImportFile(Buffer.from(csv), 'test.csv'), await prisma.caddy.findMany());
  console.log('[OK] preview', preview.summary);
  if (preview.summary.update < 1 || preview.summary.new < 1) throw new Error('preview counts unexpected');

  await applyImportPayload(preview.applyPayload, prisma);
  const afterApply = await prisma.caddy.findUnique({ where: { id: created.id } });
  if (afterApply?.teamOrder !== 100 || afterApply?.employmentStatus !== 'ACTIVE') {
    throw new Error('apply update failed');
  }
  console.log('[OK] apply');

  // 4) missing candidate flag (upload without existing 183 ids)
  const csvSmall = 'id,name,team,teamOrder,employmentStatus\n';
  const previewMissing = buildImportPreview(parseImportFile(Buffer.from(csvSmall), 't.csv'), await prisma.caddy.findMany());
  if (previewMissing.missingCandidates.length < before.caddies) {
    console.log('[OK] missing candidates detected:', previewMissing.missingCandidates.length);
  }

  // 5) retire soft
  await prisma.caddy.update({ where: { id: created.id }, data: { employmentStatus: 'RETIRED' } });
  console.log('[OK] retire soft');

  // cleanup
  await prisma.caddy.deleteMany({ where: { OR: [{ employeeCode: 'NEW-002' }, { name: '__TEST_NEW__' }, { employeeCode: 'TEST-ROSTER-001' }] } });

  const after = await counts();
  console.log('=== AFTER ===', JSON.stringify(after));

  if (before.caddies !== after.caddies) throw new Error(`caddy count ${before.caddies} -> ${after.caddies}`);
  if (before.assignments !== after.assignments) throw new Error('assignments changed');

  console.log('ALL TESTS PASSED — preserved', before.caddies, 'caddies');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
