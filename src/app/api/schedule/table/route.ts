import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// AssignmentType → 한국어 라벨
const LABEL: Record<string, string> = {
  OFF: '휴무',
  SICK: '병가',
  LONG_SICK: '장기병가',
  DUTY: '당번',
  MARSHAL: '마샬',
  ACCIDENT: '타구사고',
  FAMILY_EVENT: '경조사',
}

function getDayRange(ymd: string) {
  // 로컬 타임존 기준 하루 범위 [00:00:00.000, 23:59:59.999]
  const start = new Date(`${ymd}T00:00:00`)
  if (Number.isNaN(start.getTime())) throw new Error('잘못된 날짜 형식')
  const end = new Date(start)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const ymd = searchParams.get('date')
    if (!ymd) {
      return NextResponse.json({ error: 'date=YYYY-MM-DD 필요' }, { status: 400 })
    }
    const { start, end } = getDayRange(ymd)

    // 팀 + 입력순(=id asc)
    const caddies = await prisma.caddy.findMany({
      orderBy: [{ team: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, team: true },
    })

    // 해당 "하루"에 걸치는 기간 지정(휴무/병가/…)
    const assignments = await prisma.assignment.findMany({
      where: {
        startDate: { lte: end },
        endDate: { gte: start },
      },
      select: { caddyId: true, type: true, subType: true },
    })

    // 같은 날짜의 수동 태그(1·3, 54, 외곽 등)
    const extras = await prisma.scheduleExtraTag.findMany({
      where: {
        date: { gte: start, lte: end },
      },
      select: { caddyId: true, tag: true },
    })

    // caddyId → badges(string[]) 맵 만들기
    const badgesByCaddy = new Map<number, string[]>()

    // 기간 지정 ⇒ 라벨화해서 추가
    for (const a of assignments) {
      const base = LABEL[a.type] ?? a.type
      const text = a.subType ? `${base}(${a.subType})` : base
      const arr = badgesByCaddy.get(a.caddyId) ?? []
      arr.push(text)
      badgesByCaddy.set(a.caddyId, arr)
    }

    // 수동 태그 ⇒ 그대로 추가
    for (const e of extras) {
      const arr = badgesByCaddy.get(e.caddyId) ?? []
      arr.push(e.tag)
      badgesByCaddy.set(e.caddyId, arr)
    }

    // 팀별 묶기
    const byTeam = new Map<string, Array<{ id: number; name: string; badges: string[] }>>()
    for (const c of caddies) {
      const team = c.team ?? ''
      if (!byTeam.has(team)) byTeam.set(team, [])
      byTeam.get(team)!.push({
        id: c.id,
        name: c.name,
        badges: badgesByCaddy.get(c.id) ?? [],
      })
    }

    // 1조~8조 순서 우선
    const teamOrder = ['1조', '2조', '3조', '4조', '5조', '6조', '7조', '8조']
    const allTeams = Array.from(byTeam.keys())
    const orderedTeams = [
      ...teamOrder.filter(t => byTeam.has(t)),
      ...allTeams.filter(t => !teamOrder.includes(t)),
    ]

    const columns = orderedTeams.map(team => ({
      team,
      rows: byTeam.get(team) ?? [],
    }))
    const maxRows = columns.reduce((m, col) => Math.max(m, col.rows.length), 0)

    return NextResponse.json({ date: ymd, columns, maxRows })
  } catch (e: any) {
    console.error('[GET /api/schedule/table] error:', e)
    return NextResponse.json({ error: e?.message ?? '가용표 생성 중 오류' }, { status: 500 })
  }
}
