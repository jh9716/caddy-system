import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Admin-only diagnostic. Public health is /api/health. */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  // 실제 테이블명으로 바꾸세요. 예: assignment
  const count = await prisma.assignment.count().catch(() => {
    return -1; // 에러 표시
  });
  const photo = await prisma
    .$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(*)::bigint AS n FROM "CourseReportPhoto"
  `
    .then((rows) => ({ ready: true, rows: Number(rows[0]?.n ?? 0) }))
    .catch(() => ({
      ready: false,
      rows: -1,
    }));
  return NextResponse.json({
    connected: count >= 0,
    count,
    courseReportPhoto: photo,
  });
}
