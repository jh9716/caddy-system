import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAccountManager } from "@/lib/auth";
import {
  STAFF_PASSWORD_ACCOUNT_WHERE,
  normalizeStaffCreateUsername,
  staffCreateUsernameIssue,
  staffCreateUsernameIssueMessage,
} from "@/lib/staffAdminAccounts";
import {
  generateTempNumericPassword,
  hashPassword,
} from "@/lib/userPassword";

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

/**
 * POST /api/admin/staff-accounts — ID/PW 일반 관리자 생성.
 * 평문 임시 비밀번호는 이 응답에 한 번만 포함. hash 비노출.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAccountManager(req);
  if (guard) return guard;

  const body = await req.json().catch(() => ({}));
  const username = normalizeStaffCreateUsername(
    (body as { username?: unknown })?.username
  );
  const issue = staffCreateUsernameIssue(username);
  if (issue) {
    return NextResponse.json(
      { error: issue, message: staffCreateUsernameIssueMessage(issue) },
      { status: 400 }
    );
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "username_taken", message: "이미 사용 중인 아이디입니다." },
        { status: 409 }
      );
    }

    const temporaryPassword = generateTempNumericPassword();
    const hashed = await hashPassword(temporaryPassword);
    const created = await prisma.user.create({
      data: {
        username,
        password: hashed,
        role: "admin",
        mustChangePassword: true,
        caddyId: null,
        managedTeams: [],
        kakaoUserId: null,
      },
      select: {
        id: true,
        username: true,
        role: true,
        mustChangePassword: true,
      },
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: created.id,
        username: created.username,
        role: created.role,
        mustChangePassword: created.mustChangePassword,
      },
      temporaryPassword,
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "username_taken", message: "이미 사용 중인 아이디입니다." },
        { status: 409 }
      );
    }
    console.error("[POST /api/admin/staff-accounts]", e);
    return NextResponse.json(
      { error: "create_failed", message: "계정 생성에 실패했습니다." },
      { status: 500 }
    );
  }
}
