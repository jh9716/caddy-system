import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAuthUser } from "@/lib/auth";
import {
  CaddyLinkRequestError,
  cancelCaddyLinkRequest,
  resolveSessionUser,
} from "@/lib/caddyLinkRequest";

export const dynamic = "force-dynamic";

/** POST — 본인 PENDING 요청 취소 (User/Caddy 미변경) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const auth = await resolveAuthUser(req);
    const username = auth?.username ?? null;
    const user = await resolveSessionUser(prisma, username);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const params = await Promise.resolve(ctx.params);
    const requestId = Number(params.id);
    const result = await cancelCaddyLinkRequest(prisma, user.id, requestId);
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
    console.error(
      "[POST /api/caddy-link-requests/:id/cancel]",
      e?.message || e
    );
    return NextResponse.json(
      { error: "internal_error", message: "취소 실패" },
      { status: 500 }
    );
  }
}
