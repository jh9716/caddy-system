import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/utils/requireAdmin'   // ✅ 여기 경로 바뀜!
import { logAudit } from '@/lib/audit'

// 캐디 수정
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    requireAdmin() // ✅ req 넘기지 않고 단순 호출로 변경
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

    await logAudit({
      action: 'UPDATE_CADDY',
      entity: 'Caddy',
      entityId: id,
      payload: body,
    })

    return NextResponse.json(updated)
  } catch (e: any) {
    console.error('[PATCH /api/caddies/[id]]', e)
    const status = e?.status ?? 400
    return NextResponse.json({ error: e?.message ?? 'PATCH failed' }, { status })
  }
}

// 캐디 삭제
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    requireAdmin() // ✅ 관리자 인증 체크
    const id = Number(params.id)

    await prisma.$transaction([
      prisma.schedule.deleteMany({ where: { caddyId: id } }),
      prisma.assignment.deleteMany({ where: { caddyId: id } }),
      prisma.caddy.delete({ where: { id } }),
    ])

    await logAudit({
      action: 'DELETE_CADDY',
      entity: 'Caddy',
      entityId: id,
    })

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[DELETE /api/caddies/[id]]', e)
    const status = e?.status ?? 400
    return NextResponse.json({ error: e?.message ?? 'DELETE failed' }, { status })
  }
}
