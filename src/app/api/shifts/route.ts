// src/app/api/shifts/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'
import {
  ShiftDutyReplaceEmptyError,
  isShiftDutyReplaceEmptyError,
} from '@/lib/shiftDutyReplace'

type GenerateBody = {
  date: string               // 'YYYY-MM-DD'
  part: 'ONE' | 'TWO' | 'THREE'
  variant?: 'NORMAL' | 'ONE_THREE' | 'ONE_TWO' | 'FIFTY_FOUR'
  slotsPerTeam: number       // 팀별 몇 명?
  teams: string[]            // 예: ["5조","8조"]
}

// 특이사항 메모 기준 제외 키워드(필요 시 AssignmentType로 변경 가능)
const EXCLUDE_KEYWORDS = ['휴무','병가','장기병가','경조사','타구사고']

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if (guard) return guard

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  const part = searchParams.get('part') as GenerateBody['part'] | null
  if (!date || !part) return NextResponse.json({ error: 'date, part가 필요합니다.' }, { status: 400 })

  const list = await prisma.shiftDuty.findMany({
    where: { date: new Date(date), part },
    include: {
      // phoneNormalized 등 PII 제외 — consumer는 name/team 사용
      caddy: {
        select: {
          id: true,
          name: true,
          team: true,
          teamOrder: true,
          employeeCode: true,
          employmentStatus: true,
          missingFromImport: true,
          caddyType: true,
          status: true,
          extraFlags: true,
          memo: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
    orderBy: [{ orderNo: 'asc' }],
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

    // 2) 팀별 캐디 수집(근무 가능자만). RETIRED만 제외, LEAVE는 기존 정책 유지.
    const all = await prisma.caddy.findMany({
      where: { employmentStatus: { not: 'RETIRED' } },
      orderBy: { id: 'asc' },
    })
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

    // 3–5) 같은 (date, part) 삭제 + 생성은 한 트랜잭션.
    // count는 delete 이후라 기존 해당 일자 행을 라운드로빈에 넣지 않는다.
    const createdCount = await prisma.$transaction(async (tx) => {
      await tx.shiftDuty.deleteMany({ where: { date: d, part } })

      let orderCounter = 1
      const toCreate: {
        date: Date; part: any; variant: any;
        orderNo: number; caddyId: number; team?: string | null
      }[] = []

      for (const team of teams) {
        const arr = teamMap.get(team) || []
        if (arr.length === 0) continue

        const assignedCount = await tx.shiftDuty.count({ where: { team } })
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

      if (toCreate.length === 0) {
        throw new ShiftDutyReplaceEmptyError()
      }
      await tx.shiftDuty.createMany({ data: toCreate })
      return toCreate.length
    })

    return NextResponse.json({ ok: true, count: createdCount })
  } catch (e: any) {
    if (isShiftDutyReplaceEmptyError(e)) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    console.error('POST /api/shifts error', e)
    return NextResponse.json({ error: e?.message ?? 'shift 생성 실패' }, { status: 500 })
  }
}
