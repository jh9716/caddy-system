import { NextResponse } from 'next/server'
import dayjs from 'dayjs'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const start = dayjs().startOf('day').toDate()
  const end = dayjs().endOf('day').toDate()

  const totalCaddies = await prisma.caddy.count()

  // 오늘 날짜와 겹치는 배정(기간 겹침)
  const [off, sick, longSick, duty, marshal] = await Promise.all([
    prisma.assignment.count({
      where: { type: 'OFF', startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: 'SICK', startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: 'LONG_SICK', startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: 'DUTY', startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: 'MARSHAL', startDate: { lte: end }, endDate: { gte: start } },
    }),
  ])

  const latestNotices = await prisma.notice.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, title: true, createdAt: true },
  })

  return NextResponse.json({
    date: dayjs().format('YYYY-MM-DD'),
    totalCaddies,
    today: { off, sick, longSick, duty, marshal },
    latestNotices,
  })
}
