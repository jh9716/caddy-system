import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAuthUser } from "@/lib/auth";
import { applySessionCookies } from "@/lib/sessionCookies";
import {
  newPasswordIssueMessage,
  validateNewPassword,
} from "@/lib/passwordPolicy";
import { hashPassword, verifyUserPassword } from "@/lib/userPassword";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/change-password
 * 현재 로그인 User 본인만. 다른 사용자 비밀번호는 변경할 수 없다.
 */
export async function POST(req: NextRequest) {
  const auth = await resolveAuthUser(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.userId == null) {
    return NextResponse.json(
      {
        error: "env_account",
        message: "환경변수 계정은 이 화면에서 비밀번호를 바꿀 수 없습니다.",
      },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const currentPassword = String(body?.currentPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");

  const issue = validateNewPassword(newPassword, currentPassword);
  if (issue) {
    return NextResponse.json(
      { error: issue, message: newPasswordIssueMessage(issue) },
      { status: 400 }
    );
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        username: true,
        password: true,
        role: true,
      },
    });
    if (!user || user.username !== auth.username) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const currentOk = await verifyUserPassword(currentPassword, user.password);
    if (!currentOk) {
      return NextResponse.json(
        {
          error: "bad_current_password",
          message: "현재 비밀번호가 올바르지 않습니다.",
        },
        { status: 400 }
      );
    }

    const hashed = await hashPassword(newPassword);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        mustChangePassword: false,
        sessionVersion: { increment: 1 },
      },
      select: {
        id: true,
        username: true,
        role: true,
        sessionVersion: true,
        mustChangePassword: true,
      },
    });

    const res = NextResponse.json({
      ok: true,
      mustChangePassword: updated.mustChangePassword === true,
    });
    await applySessionCookies(res, req, {
      userId: updated.id,
      username: updated.username,
      role: auth.role,
      sessionVersion: updated.sessionVersion,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/auth/change-password]", e);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
