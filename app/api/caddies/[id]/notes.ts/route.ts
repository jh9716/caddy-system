import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// 메모 저장용 테이블이 없으니, 빠르게 쓰시라고 Audit 테이블을 재활용합니다.
// action: 'CADDY_NOTE', entity: 'Caddy', entityId: caddyId, payload: { text }
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const caddyId = Number(params.id)
  if (!caddyId) return NextResponse.json([], { status: 200 })
  const logs = await prisma.audit.findMany({
    where: { entity: 'Caddy', entityId: caddyId, action: 'CADDY_NOTE' },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true, createdAt: true },
  })
  // payload?.text만 꺼내서 돌려줌
  return NextResponse.json(logs.map(l => ({ id: l.id, text: (l.payload as any)?.text ?? '', createdAt: l.createdAt })))
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const caddyId = Number(params.id)
    const { text } = await req.json()
    if (!caddyId || !text) return NextResponse.json({ error: '잘못된 요청' }, { status: 400 })
    const created = await prisma.audit.create({
      data: { action: 'CADDY_NOTE', entity: 'Caddy', entityId: caddyId, payload: { text } },
    })
    return NextResponse.json({ id: created.id })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? '저장 실패' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const caddyId = Number(params.id)
    const { searchParams } = new URL(req.url)
    const noteId = Number(searchParams.get('noteId'))
    if (!caddyId || !noteId) return NextResponse.json({ error: '잘못된 요청' }, { status: 400 })
    await prisma.audit.delete({ where: { id: noteId } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? '삭제 실패' }, { status: 500 })
  }
}
