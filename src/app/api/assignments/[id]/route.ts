import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// 단일 조회
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const assignment = await prisma.assignment.findUnique({
    where: { id: Number(params.id) },
    include: { caddy: true },
  })
  if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(assignment)
}

// 수정
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const data = await req.json()
  const updated = await prisma.assignment.update({
    where: { id: Number(params.id) },
    data,
  })
  return NextResponse.json(updated)
}

// 삭제
export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await prisma.assignment.delete({ where: { id: Number(params.id) } })
  return NextResponse.json({ success: true })
}
