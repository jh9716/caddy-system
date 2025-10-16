import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/utils/guards'

export const dynamic = 'force-dynamic'

// 단건 조회 (상세 페이지 SSR에서 사용)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id)
  const notice = await prisma.notice.findUnique({ where: { id } })
  if (!notice) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(notice)
}

// 수정 (관리자)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await requireAdmin()
  const id = Number(params.id)
  const body = await req.json()
  const updated = await prisma.notice.update({
    where: { id },
    data: {
      title: body.title ?? undefined,
      body: body.body ?? undefined,
    },
  })
  return NextResponse.json(updated)
}

// 삭제 (관리자)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await requireAdmin()
  const id = Number(params.id)
  await prisma.notice.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
