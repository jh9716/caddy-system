import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth';

// GET: 공지 목록
export async function GET() {
  const rows = await prisma.notice.findMany({
    orderBy: { createdAt: 'desc' }
  });
  return NextResponse.json(rows);
}

// POST: 공지 등록(관리자)
export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard; // 401

  const { title, content, author } = await req.json();
  if (!title || !content) {
    return NextResponse.json({ error: 'title, content는 필수입니다.' }, { status: 400 });
  }

  const row = await prisma.notice.create({
    data: { title, content, author: author ?? null },
  });

  return NextResponse.json(row, { status: 201 });
}
