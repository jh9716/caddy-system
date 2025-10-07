import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const id = Number(params.id);

    const updated = await prisma.assignment.update({
      where: { id },
      data: {
        type: body.type ?? undefined,
        subType: body.subType ?? undefined,
        startDate: body.startDate ? new Date(body.startDate) : undefined,
        endDate: body.endDate ? new Date(body.endDate) : undefined,
        comment: body.comment ?? undefined,
      },
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error('PATCH /api/assignments/[id] error:', e);
    return NextResponse.json({ error: e?.message ?? '수정 실패' }, { status: 500 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = Number(params.id);
    await prisma.assignment.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/assignments/[id] error:', e);
    return NextResponse.json({ error: e?.message ?? '삭제 실패' }, { status: 500 });
  }
}
