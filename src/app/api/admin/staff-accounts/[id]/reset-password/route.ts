import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAccountManager } from "@/lib/auth";
import { STAFF_PASSWORD_ACCOUNT_WHERE } from "@/lib/staffAdminAccounts";
import {
  generateTempNumericPassword,
  hashPassword,
} from "@/lib/userPassword";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/staff-accounts/[id]/reset-password
 * 관리자가 직원 임시 비밀번호를 재발급. 평문은 이 응답에 한 번만 포함.
 * password hash는 응답에 넣지 않는다.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAccountManager(req);
  if (guard) return guard;

  const resolved = await Promise.resolve(params);
  const id = Number(resolved.id);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const user = await prisma.user.findFirst({
      where: { id, ...STAFF_PASSWORD_ACCOUNT_WHERE },
      select: {
        id: true,
        username: true,
        role: true,
        sessionVersion: true,
      },
    });
    if (!user) {
      return NextResponse.json(
        { error: "not_found", message: "재설정할 직원 계정이 없습니다." },
        { status: 404 }
      );
    }

    const temporaryPassword = generateTempNumericPassword();
    const hashed = await hashPassword(temporaryPassword);

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        mustChangePassword: true,
        sessionVersion: { increment: 1 },
      },
      select: {
        id: true,
        username: true,
        role: true,
        mustChangePassword: true,
        sessionVersion: true,
      },
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        mustChangePassword: updated.mustChangePassword,
      },
      temporaryPassword,
    });
  } catch (e) {
    console.error("[POST /api/admin/staff-accounts/:id/reset-password]", e);
    return NextResponse.json(
      { error: "update_failed", message: "비밀번호 재설정에 실패했습니다." },
      { status: 500 }
    );
  }
}
