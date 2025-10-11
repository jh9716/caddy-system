import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// POST: 기간 지정 생성
export async function POST(req: NextRequest) {
  try {
    const { caddyId, type, startDate, endDate } = await req.json();

    if (!caddyId || !type || !startDate || !endDate) {
      return NextResponse.json({ error: '필수 값이 누락되었습니다.' }, { status: 400 });
    }

    // 캐디 존재 확인
    const exists = await prisma.caddy.findUnique({ where: { id: Number(caddyId) } });
    if (!exists) {
      return NextResponse.json({ error: '존재하지 않는 캐디입니다.' }, { status: 404 });
    }

    const created = await prisma.assignment.create({
      data: {
        caddyId: Number(caddyId),
        type, // AssignmentType enum
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      },
    });

    return NextResponse.json(created);
  } catch (e: any) {
    console.error('Assignment POST Error:', e);
    return NextResponse.json({ error: e?.message || '등록 실패' }, { status: 500 });
  }
}

// GET: 특정 캐디의 기간 지정 목록
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const caddyId = Number(searchParams.get('caddyId'));
    if (!caddyId) return NextResponse.json({ error: 'caddyId 필요' }, { status: 400 });

    const list = await prisma.assignment.findMany({
      where: { caddyId },
      orderBy: [{ startDate: 'desc' }],
    });

    return NextResponse.json(list);
  } catch (e: any) {
    console.error('Assignment GET Error:', e);
    return NextResponse.json({ error: e?.message || '조회 실패' }, { status: 500 });
  }
}
