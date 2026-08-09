/**
 * ⛔ 직접 실행 비활성
 *
 * 이 스크립트는 기존에 무조건 create를 시도해 기존 183명 ID를 깨뜨릴 수 있습니다.
 * 명단 갱신은 lib/caddyImport.ts 기반 preview/apply
 * ( /api/caddies/import/preview , /api/caddies/import/apply )를 사용하세요.
 *
 * 강제 실행이 필요하면 ALLOW_LEGACY_IMPORT=1 을 설정하세요. (비권장)
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

if (process.env.ALLOW_LEGACY_IMPORT !== '1') {
  console.error(`
⛔ scripts/import-caddies.mjs 실행이 차단되었습니다.

기존 183명 ID를 보존하려면 다음을 사용하세요:
  - POST /api/caddies/import/preview
  - POST /api/caddies/import/apply
  - 단위 테스트: npx tsx scripts/test-caddy-roster-unit.ts

레거시 스크립트를 강제로 쓰려면 ALLOW_LEGACY_IMPORT=1 (비권장)
`)
  process.exit(1)
}

const prisma = new PrismaClient()

async function main() {
  const file = path.resolve('caddies.csv')
  if (!fs.existsSync(file)) {
    console.error('caddies.csv 파일이 프로젝트 루트에 없습니다.')
    process.exit(1)
  }
  const text = fs.readFileSync(file, 'utf8').trim()
  const [header, ...lines] = text.split(/\r?\n/)
  const cols = header.split(',').map(s=>s.trim())
  const ti = cols.indexOf('team')
  const ni = cols.indexOf('name')
  if (ti === -1 || ni === -1) {
    console.error('CSV 헤더에 team,name 컬럼이 필요합니다.')
    process.exit(1)
  }

  let count = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',').map(s=>s.trim())
    const team = parts[ti]
    const name = parts[ni]
    if (!team || !name) continue

    await prisma.caddy.create({
      data: { team, name }
    }).catch(async () => {
      await prisma.caddy.update({
        where: { name },
        data: { team }
      }).catch(() => {})
    })
    count++
  }

  console.log(`Imported ~${count} caddies`)
}

main().finally(()=>prisma.$disconnect())
