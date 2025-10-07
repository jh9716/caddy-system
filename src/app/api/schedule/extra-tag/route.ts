import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'

function toDateRange(ymd: string) {
  const start = new Date(ymd + 'T00:00:00.000Z');
  const end = new Date(ymd + 'T23:59:59.999Z');
  return { start, end };
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);

    const { date, caddyId, tag, createdBy } = await req.json();
    if (!date || !caddyId || !tag) {
      return NextResponse.json({ error: 'date, caddyId, tag 필요' }, { status: 400 });
    }
    const { start, end } = toDateRange(date);

    // 같은 날짜범위 동일 캐디 동일 태그가 없으면 생성
    const exists = await prisma.scheduleExtraTag.findFirst({
      where: { caddyId, tag, date: { gte: start, lte: end } },
    });
    if (!exists) {
      await prisma.scheduleExtraTag.create({
        data: { caddyId, tag, date: new Date(date), createdBy: createdBy ?? null },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message || 'failed';
    return NextResponse.json({ error: msg }, { status: e?.status || 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);

    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date');
    const caddyId = Number(searchParams.get('caddyId'));
    const tag = searchParams.get('tag') || '';
    if (!date || !caddyId || !tag) {
      return NextResponse.json({ error: 'date, caddyId, tag 필요' }, { status: 400 });
    }
    const { start, end } = toDateRange(date);

    await prisma.scheduleExtraTag.deleteMany({
      where: { caddyId, tag, date: { gte: start, lte: end } },
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message || 'failed';
    return NextResponse.json({ error: msg }, { status: e?.status || 500 });
  }
}
