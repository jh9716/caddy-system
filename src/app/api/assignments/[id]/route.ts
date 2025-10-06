import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/utils/requireAdmin'

// 단일 조회
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = Number(params.id)
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { caddy: true },
    })
    if (!assignment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(assignment)
  } catch (e: any) {
    console.error('[GET /api/assignments/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'GET failed' }, { status: 500 })
  }
}

// 수정
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    requireAdmin() // 관리자만 수정 가능

    const id = Number(params.id)
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }

    const body = await req.json() as {
      caddyId?: number
      type?: string
      startDate?: string | Date
      endDate?: string | Date
    }

    const data: any = {}
    if (typeof body.caddyId === 'number') data.caddyId = body.caddyId
    if (typeof body.type === 'string') data.type = body.type
    if (body.startDate) data.startDate = new Date(body.startDate)
    if (body.endDate) data.endDate = new Date(body.endDate)

    const updated = await prisma.assignment.update({
      where: { id },
      data,
      include: { caddy: true },
    })

    return NextResponse.json(updated)
  } catch (e: any) {
    console.error('[PATCH /api/assignments/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'PATCH failed' }, { status: 400 })
  }
}

// 삭제
export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    requireAdmin() // 관리자만 삭제 가능

    const id = Number(params.id)
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }

    await prisma.assignment.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[DELETE /api/assignments/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'DELETE failed' }, { status: 400 })
  }
}
