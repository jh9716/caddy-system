import { NextResponse } from 'next/server'
import dayjs from 'dayjs'
import { prisma } from '@/lib/prisma'

export async function POST() {
  const today = dayjs().startOf('day')

  // 이미 생성된 날짜면 중복 방지
  const exists = await prisma.dailySchedule.findFirst({
    where: { date: today.toDate() },
  })
  if (exists) {
    return NextResponse.json({ message: '이미 오늘 가용표가 생성되었습니다.' })
  }

  const totalCaddies = await prisma.caddy.count()

  // Assignment 테이블 기반 상태별 카운트
  const [off, sick, longSick, duty, marshal] = await Promise.all([
    prisma.assignment.count({
      where: { type: 'OFF', startDate: { lte: today.endOf('day').toDate() }, endDate: { gte: today.toDate() } },
    }),
    prisma.assignment.count({
      where: { type: 'SICK', startDate: { lte: today.endOf('day').toDate() }, endDate: { gte: today.toDate() } },
    }),
    prisma.assignment.count({
      where: { type: 'LONG_SICK', startDate: { lte: today.endOf('day').toDate() }, endDate: { gte: today.toDate() } },
    }),
    prisma.assignment.count({
      where: { type: 'DUTY', startDate: { lte: today.endOf('day').toDate() }, endDate: { gte: today.toDate() } },
    }),
    prisma.assignment.count({
      where: { type: 'MARSHAL', startDate: { lte: today.endOf('day').toDate() }, endDate: { gte: today.toDate() } },
    }),
  ])

  const rest = off + sick + longSick
  const available = totalCaddies - rest

  await prisma.dailySchedule.create({
    data: {
      date: today.toDate(),
      available,
      rest,
      sick,
      longSick,
      duty,
      marshal,
    },
  })

  return NextResponse.json({
    message: `${today.format('YYYY-MM-DD')} 가용표 생성 완료`,
    stats: { totalCaddies, available, rest, sick, longSick, duty, marshal },
  })
}
