import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// 📘 GET: 전체 목록 조회
export async function GET() {
  try {
    const assignments = await prisma.assignment.findMany({
      include: { caddy: true },
      orderBy: { startDate: 'desc' },
    });
    return NextResponse.json(assignments);
  } catch (e: any) {
    console.error('[GET /api/assignments]', e);
    return NextResponse.json(
      { error: e?.message ?? '서버 오류' },
      { status: 500 }
    );
  }
}

// 🟢 POST: 새 일정 등록
export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { caddyId, type, startDate, endDate } = data ?? {};

    // 유효성 검사
    if (!caddyId || !type || !startDate || !endDate) {
      return NextResponse.json(
        { error: '필수 값이 누락되었습니다. (caddyId, type, startDate, endDate)' },
        { status: 400 }
      );
    }

    const assignment = await prisma.assignment.create({
      data: {
        caddyId: Number(caddyId),
        type,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      },
    });

    return NextResponse.json(assignment, { status: 201 });
  } catch (e: any) {
    console.error('[POST /api/assignments]', e);
    return NextResponse.json(
      { error: e?.message ?? '서버 오류' },
      { status: 500 }
    );
  }
}

// 🟡 PATCH: 일부 수정 (ex. 기간, 유형)
export async function PATCH(req: NextRequest) {
  try {
    const data = await req.json();
    const { id, type, startDate, endDate } = data ?? {};

    if (!id) {
      return NextResponse.json({ error: 'id가 필요합니다.' }, { status: 400 });
    }

    const updated = await prisma.assignment.update({
      where: { id: Number(id) },
      data: {
        ...(type ? { type } : {}),
        ...(startDate ? { startDate: new Date(startDate) } : {}),
        ...(endDate ? { endDate: new Date(endDate) } : {}),
      },
    });

    return NextResponse.json(updated);
  } catch (e: any) {
    console.error('[PATCH /api/assignments]', e);
    return NextResponse.json(
      { error: e?.message ?? '서버 오류' },
      { status: 500 }
    );
  }
}

// 🔴 DELETE: 삭제
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id가 필요합니다.' }, { status: 400 });
    }

    await prisma.assignment.delete({ where: { id: Number(id) } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[DELETE /api/assignments]', e);
    return NextResponse.json(
      { error: e?.message ?? '서버 오류' },
      { status: 500 }
    );
  }
}
