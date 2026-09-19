import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  // 실제 테이블명으로 바꾸세요. 예: assignment
  const count = await prisma.assignment.count().catch((e) => {
    return -1; // 에러 표시
  });
  const photo = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(*)::bigint AS n FROM "CourseReportPhoto"
  `.then((rows) => ({ ready: true, rows: Number(rows[0]?.n ?? 0) })).catch(() => ({
    ready: false,
    rows: -1,
  }));
  return NextResponse.json({ connected: count >= 0, count, courseReportPhoto: photo });
}
