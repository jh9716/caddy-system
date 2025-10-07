import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
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

    // 이름이 유니크하지 않다면(예: 김현정1, 김현정2처럼) 스키마 그대로 사용하면 됩니다.
    // 이름을 유니크로 관리하고 싶다면 Caddy.name @unique 추가하고 필요시 suffix 조정.
    await prisma.caddy.create({
      data: { team, name }
    }).catch(async (e) => {
      // 이미 존재하면 팀만 업데이트 (이름을 유니크로 쓰는 경우에만 의미있음)
      await prisma.caddy.update({
        where: { name },
        data: { team }
      }).catch(() => {}) // 신규/갱신 모두 실패하면 무시
    })
    count++
  }

  console.log(`Imported ~${count} caddies`)
}

main().finally(()=>prisma.$disconnect())
