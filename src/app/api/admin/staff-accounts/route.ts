import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAccountManager } from "@/lib/auth";
import { STAFF_PASSWORD_ACCOUNT_WHERE } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/admin/staff-accounts — ID/PW 직원 계정 목록. hash 비노출. */
export async function GET(req: NextRequest) {
  const guard = await requireAccountManager(req);
  if (guard) return guard;

  try {
    const users = await prisma.user.findMany({
      where: STAFF_PASSWORD_ACCOUNT_WHERE,
      select: {
        id: true,
        username: true,
        role: true,
        mustChangePassword: true,
        caddyId: true,
        createdAt: true,
      },
      orderBy: [{ id: "asc" }],
    });

    return NextResponse.json({
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        mustChangePassword: u.mustChangePassword,
        caddyId: u.caddyId,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[GET /api/admin/staff-accounts]", e);
    return NextResponse.json(
      { error: "internal_error", message: "목록 조회 실패" },
      { status: 500 }
    );
  }
}
