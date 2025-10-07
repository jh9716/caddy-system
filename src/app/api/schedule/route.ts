import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET: /api/schedules?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date')
    if (!date) return NextResponse.json({ error: '날짜가 필요합니다.' }, { status: 400 })

    const schedules = await prisma.schedule.findMany({
      where: { date: new Date(date) },
      include: { caddy: true },
      orderBy: { caddyId: 'asc' },
    })
    return NextResponse.json(schedules)
  } catch (error) {
    console.error('GET /api/schedules error:', error)
    return NextResponse.json({ error: '가용표를 불러오는 중 오류가 발생했습니다.' }, { status: 500 })
  }
}

// POST: /api/schedules { date: 'YYYY-MM-DD' }
export async function POST(req: NextRequest) {
  try {
    const { date } = await req.json()
    if (!date) return NextResponse.json({ error: '날짜가 필요합니다.' }, { status: 400 })

    const caddies = await prisma.caddy.findMany()
    if (caddies.length === 0) {
      return NextResponse.json({ error: '등록된 캐디가 없습니다.' }, { status: 404 })
    }

    const assigns = await prisma.assignment.findMany({
      where: {
        startDate: { lte: new Date(date) },
        endDate: { gte: new Date(date) },
      },
    })

    const data = caddies.map(c => {
      const a = assigns.find(x => x.caddyId === c.id)
      let memo = ''
      if (a) {
        if (a.type === 'SICK') memo = '병가'
        else if (a.type === 'LONG_SICK') memo = '장기병가'
        else if (a.type === 'OFF') memo = '휴무'
        else if (a.type === 'DUTY') memo = '당번'
        else if (a.type === 'MARSHAL') memo = '마샬'
      }
      return { date: new Date(date), caddyId: c.id, memo }
    })

    await prisma.schedule.deleteMany({ where: { date: new Date(date) } })
    await prisma.schedule.createMany({ data })

    return NextResponse.json({ ok: true, message: '가용표가 자동 생성되었습니다.' })
  } catch (error) {
    console.error('POST /api/schedules error:', error)
    return NextResponse.json({ error: '가용표 생성 중 오류가 발생했습니다.' }, { status: 500 })
  }
}
