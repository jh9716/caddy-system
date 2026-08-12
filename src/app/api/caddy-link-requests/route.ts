import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getUsernameFromCookies } from "@/lib/sessionCookies";
import {
  CaddyLinkRequestError,
  listPendingCaddyLinkRequests,
  resolveSessionUser,
  submitCaddyLinkRequest,
} from "@/lib/caddyLinkRequest";

export const dynamic = "force-dynamic";

/** POST — 직원 본인확인 제출 (PENDING만, User/Caddy 미변경) */
export async function POST(req: NextRequest) {
  try {
    const username = getUsernameFromCookies(req.cookies);
    const user = await resolveSessionUser(prisma, username);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const result = await submitCaddyLinkRequest(prisma, user.id, {
      name: body?.name,
      phone: body?.phone,
    });
    return NextResponse.json({ ok: true, request: result });
  } catch (e: any) {
    if (e instanceof CaddyLinkRequestError) {
      return NextResponse.json(
        {
          error: e.code,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        },
        { status: e.status }
      );
    }
    console.error("[POST /api/caddy-link-requests]", e?.message || e);
    return NextResponse.json(
      { error: "internal_error", message: "요청 처리 실패" },
      { status: 500 }
    );
  }
}

/** GET — admin PENDING 목록 (?status=PENDING) */
export async function GET(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const status = (
      req.nextUrl.searchParams.get("status") || "PENDING"
    ).toUpperCase();
    if (status !== "PENDING") {
      return NextResponse.json(
        {
          error: "invalid_status",
          message: "현재 PENDING 목록만 지원합니다.",
        },
        { status: 400 }
      );
    }
    const requests = await listPendingCaddyLinkRequests(prisma);
    return NextResponse.json({ ok: true, requests });
  } catch (e: any) {
    console.error("[GET /api/caddy-link-requests]", e?.message || e);
    return NextResponse.json(
      { error: "internal_error", message: "목록 조회 실패" },
      { status: 500 }
    );
  }
}
