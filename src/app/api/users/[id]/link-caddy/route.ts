import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  UserCaddyLinkError,
  linkUserToCaddy,
} from "@/lib/userCaddyLink";

export const dynamic = "force-dynamic";

/** POST — Kakao User.caddyId 연결 (caddyId 필드만 write) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const params = await Promise.resolve(ctx.params);
    const userId = Number(params.id);
    const body = await req.json().catch(() => ({}));
    const caddyId = Number(body?.caddyId);

    const result = await linkUserToCaddy(prisma, userId, caddyId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UserCaddyLinkError) {
      return NextResponse.json(
        {
          error: e.code,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        },
        { status: e.status }
      );
    }
    console.error("[POST /api/users/:id/link-caddy]", e);
    return NextResponse.json(
      { error: "internal_error", message: "연결 처리 실패" },
      { status: 500 }
    );
  }
}
