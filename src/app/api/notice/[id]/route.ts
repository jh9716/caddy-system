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

    const notice = await prisma.notice.findUnique({
      where: { id },
    })

    if (!notice) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(notice)
  } catch (e: any) {
    console.error('[GET /api/notice/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'GET failed' }, { status: 500 })
  }
}

// 수정
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdmin() // 관리자만 수정

    const id = Number(params.id)
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }

    const body = await req.json() as {
      title?: string
      content?: string
      author?: string | null
    }

    const updated = await prisma.notice.update({
      where: { id },
      data: {
        title: body.title ?? undefined,
        content: body.content ?? undefined,
        author: body.author ?? undefined,
      },
    })

    return NextResponse.json(updated)
  } catch (e: any) {
    console.error('[PATCH /api/notice/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'PATCH failed' }, { status: 400 })
  }
}

// 삭제
export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdmin() // 관리자만 삭제

    const id = Number(params.id)
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 })
    }

    await prisma.notice.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[DELETE /api/notice/[id]]', e)
    return NextResponse.json({ error: e?.message ?? 'DELETE failed' }, { status: 400 })
  }
}
