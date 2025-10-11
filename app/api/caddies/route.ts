import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ✅ GET: 전체 캐디 목록 조회
export async function GET() {
  try {
    const caddies = await prisma.caddy.findMany({
      orderBy: [{ team: 'asc' }, { id: 'asc' }],
    });
    return NextResponse.json(caddies);
  } catch (e: any) {
    console.error('GET /api/caddies error:', e);
    return NextResponse.json({ error: e?.message || '불러오기 실패' }, { status: 500 });
  }
}

// ✅ POST: 캐디 추가
export async function POST(req: NextRequest) {
  try {
    const { name, team } = await req.json();
    if (!name || !team) {
      return NextResponse.json({ error: '이름과 팀은 필수입니다.' }, { status: 400 });
    }

    const created = await prisma.caddy.create({
      data: { name, team },
    });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error('POST /api/caddies error:', e);
    return NextResponse.json({ error: e?.message || '추가 실패' }, { status: 500 });
  }
}

// ✅ DELETE: 캐디 삭제 (관련 데이터 먼저 정리)
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get('id'));
    if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });

    // ⚙️ 연결된 데이터 먼저 제거
    await prisma.schedule.deleteMany({ where: { caddyId: id } });
    await prisma.assignment.deleteMany({ where: { caddyId: id } });
    await prisma.shiftDuty.deleteMany({ where: { caddyId: id } });

    // ⚙️ 캐디 삭제
    await prisma.caddy.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/caddies error:', e);
    return NextResponse.json({ error: e?.message || '삭제 실패' }, { status: 500 });
  }
}
