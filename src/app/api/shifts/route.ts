// src/app/api/shifts/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'

type GenerateBody = {
  date: string               // 'YYYY-MM-DD'
  part: 'ONE' | 'TWO' | 'THREE'
  variant?: 'NORMAL' | 'ONE_THREE' | 'ONE_TWO' | 'FIFTY_FOUR'
  slotsPerTeam: number       // 팀별 몇 명?
  teams: string[]            // 예: ["5조","8조"]
}

// 특이사항 메모 기준 제외 키워드(필요 시 AssignmentType로 변경 가능)
const EXCLUDE_KEYWORDS = ['휴무','병가','장기병가','경조사','타구사고']

// 팀별 누적 배정 수 → 라운드로빈 시작 인덱스용
async function getTeamAssignedCount(team: string) {
  // 누적 개수를 세어 간단히 시작 인덱스 계산(더 정교하게 하려면 별도 테이블 추천)
  const count = await prisma.shiftDuty.count({ where: { team } })
  return count
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  const part = searchParams.get('part') as GenerateBody['part'] | null
  if (!date || !part) return NextResponse.json({ error: 'date, part가 필요합니다.' }, { status: 400 })

  const list = await prisma.shiftDuty.findMany({
    where: { date: new Date(date), part },
    include: { caddy: true },
    orderBy: [{ orderNo: 'asc' }]
  })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  try {
    // 관리자만
    const guard = await requireAdmin(req)
    if (guard) return guard

    const body = (await req.json()) as GenerateBody
    const { date, part, variant = 'NORMAL', slotsPerTeam, teams } = body
    if (!date || !part || !slotsPerTeam || !teams?.length) {
      return NextResponse.json({ error: 'date/part/slotsPerTeam/teams는 필수입니다.' }, { status: 400 })
    }

    const d = new Date(date)

    // 1) 배제 대상(휴무/병가 등) 사전 수집
    const assigns = await prisma.assignment.findMany({
      where: { startDate: { lte: d }, endDate: { gte: d } },
      include: { caddy: true }
    })
    const excludedIdSet = new Set<number>()
    for (const a of assigns) {
      const memoText =
        a.type === 'OFF' ? '휴무' :
        a.type === 'SICK' ? '병가' :
        a.type === 'LONG_SICK' ? '장기병가' :
        a.type === 'DUTY' ? '당번' :
        a.type === 'MARSHAL' ? '마샬' : ''
      const combo = [memoText, a.caddy?.memo || ''].join(' ')
      if (EXCLUDE_KEYWORDS.some(k => combo.includes(k))) {
        excludedIdSet.add(a.caddyId)
      }
    }

    // 2) 팀별 캐디 수집(근무 가능자만)
    const all = await prisma.caddy.findMany({ orderBy: { id: 'asc' } })
    // 팀 문자열이 없다면 빈 팀으로 들어갈 수 있으니 안전 처리
    const teamMap = new Map<string, { id: number; name: string; team: string | null }[]>()
    for (const t of teams) teamMap.set(t, [])
    for (const c of all) {
      if (!c.team) continue
      if (!teamMap.has(c.team)) continue
      if (excludedIdSet.has(c.id)) continue
      teamMap.get(c.team)!.push({ id: c.id, name: c.name, team: c.team })
    }
    // 팀별 정렬(이름/ID 기준)
    for (const [k, arr] of teamMap) {
      arr.sort((a, b) => a.id - b.id)
      teamMap.set(k, arr)
    }

    // 3) 기존 동일 (date, part) 삭제
    await prisma.shiftDuty.deleteMany({ where: { date: d, part } })

    // 4) 팀별 라운드로빈 배치 생성
    let orderCounter = 1
    const toCreate: {
      date: Date; part: any; variant: any;
      orderNo: number; caddyId: number; team?: string | null
    }[] = []

    for (const team of teams) {
      const arr = teamMap.get(team) || []
      if (arr.length === 0) continue

      const assignedCount = await getTeamAssignedCount(team)
      let startIdx = assignedCount % arr.length

      for (let i = 0; i < slotsPerTeam; i++) {
        const pick = arr[(startIdx + i) % arr.length]
        toCreate.push({
          date: d,
          part,
          variant,
          orderNo: orderCounter++,
          caddyId: pick.id,
          team: team,
        })
      }
    }

    // 5) 생성
    if (toCreate.length === 0) {
      return NextResponse.json({ error: '할당 가능한 인원이 없습니다.' }, { status: 400 })
    }
    await prisma.shiftDuty.createMany({ data: toCreate })

    return NextResponse.json({ ok: true, count: toCreate.length })
  } catch (e: any) {
    console.error('POST /api/shifts error', e)
    return NextResponse.json({ error: e?.message ?? 'shift 생성 실패' }, { status: 500 })
  }
}
