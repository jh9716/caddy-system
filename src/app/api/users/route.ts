import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { listKakaoUsersForAdmin } from "@/lib/userCaddyLink";

export const dynamic = "force-dynamic";

/** GET — Kakao User 목록 (admin). admin role User는 목록에서 제외 */
export async function GET(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const { users, occupiedCaddyIds } = await listKakaoUsersForAdmin(prisma);
    return NextResponse.json({
      ok: true,
      users: users.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
      })),
      occupiedCaddyIds,
    });
  } catch (e) {
    console.error("[GET /api/users]", e);
    return NextResponse.json(
      { error: "internal_error", message: "목록 조회 실패" },
      { status: 500 }
    );
  }
}
