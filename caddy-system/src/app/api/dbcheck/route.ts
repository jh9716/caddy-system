import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  // 실제 테이블명으로 바꾸세요. 예: assignment
  const count = await prisma.assignment.count().catch((e) => {
    return -1; // 에러 표시
  });
  return NextResponse.json({ connected: count >= 0, count });
}
