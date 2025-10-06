// src/app/api/caddies/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

// 부분 수정
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdmin(req) // ← req 넘겨주기
    const id = Number(params.id)
    const body = await req.json()

    const updated = await prisma.caddy.update({
      where: { id },
      data: {
        name: body.name ?? undefined,
        team: body.team ?? undefined,
        status: body.status ?? undefined,
        memo: body.memo ?? undefined,
      },
    })

    await logAudit({ action: 'UPDATE_CADDY', entity: 'Caddy', entityId: id, payload: body })
    return NextResponse.json(updated)
  } catch (e: any) {
    console.error('[PATCH /api/caddies/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'PATCH failed' }, { status: e?.status ?? 400 })
  }
}

// 삭제 (자식 → 부모 순서)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdmin(req) // ← req 넘겨주기
    const id = Number(params.id)

    await prisma.$transaction([
      prisma.schedule.deleteMany({ where: { caddyId: id } }),
      prisma.assignment.deleteMany({ where: { caddyId: id } }),
      prisma.caddy.delete({ where: { id } }),
    ])

    await logAudit({ action: 'DELETE_CADDY', entity: 'Caddy', entityId: id })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[DELETE /api/caddies/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'DELETE failed' }, { status: e?.status ?? 400 })
  }
}
