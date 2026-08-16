import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  UserCaddyLinkError,
  unlinkUserFromCaddy,
} from "@/lib/userCaddyLink";

export const dynamic = "force-dynamic";

/** POST — Kakao User.caddyId 연결 해제 (null만) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const params = await Promise.resolve(ctx.params);
    const userId = Number(params.id);
    const result = await unlinkUserFromCaddy(prisma, userId);
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
    console.error("[POST /api/users/:id/unlink-caddy]", e);
    return NextResponse.json(
      { error: "internal_error", message: "연결 해제 실패" },
      { status: 500 }
    );
  }
}
