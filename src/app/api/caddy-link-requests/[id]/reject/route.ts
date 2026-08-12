import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getUsernameFromCookies } from "@/lib/sessionCookies";
import {
  CaddyLinkRequestError,
  rejectCaddyLinkRequest,
  resolveSessionUser,
} from "@/lib/caddyLinkRequest";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** POST — admin 반려 (User/Caddy 미변경) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const params = await Promise.resolve(ctx.params);
    const requestId = Number(params.id);
    const body = await req.json().catch(() => ({}));
    const decisionNote =
      body?.decisionNote == null ? null : String(body.decisionNote);

    const username = getUsernameFromCookies(req.cookies);
    const admin = await resolveSessionUser(prisma, username);
    const adminUserId = admin?.id ?? null;

    const result = await rejectCaddyLinkRequest(
      prisma,
      requestId,
      adminUserId,
      decisionNote
    );

    await logAudit({
      action: "REJECT_CADDY_LINK_REQUEST",
      meta: {
        entity: "CaddyLinkRequest",
        entityId: result.requestId,
        decisionNote: decisionNote
          ? String(decisionNote).slice(0, 200)
          : null,
      },
    });

    return NextResponse.json({ ok: true, ...result });
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
      "[POST /api/caddy-link-requests/:id/reject]",
      e?.message || e
    );
    return NextResponse.json(
      { error: "internal_error", message: "반려 실패" },
      { status: 500 }
    );
  }
}
