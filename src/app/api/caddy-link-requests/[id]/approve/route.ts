import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getUsernameFromCookies } from "@/lib/sessionCookies";
import {
  CaddyLinkRequestError,
  approveCaddyLinkRequest,
  resolveSessionUser,
} from "@/lib/caddyLinkRequest";
import { maskKrMobile } from "@/lib/caddyPhone";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** POST — admin 승인 TX (User.caddyId + Caddy.phoneNormalized + APPROVED) */
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
    const selectedCaddyId = Number(body?.selectedCaddyId);

    const username = getUsernameFromCookies(req.cookies);
    const admin = await resolveSessionUser(prisma, username);
    const adminUserId = admin?.id ?? null;

    const result = await approveCaddyLinkRequest(
      prisma,
      requestId,
      selectedCaddyId,
      adminUserId
    );

    await logAudit({
      action: "APPROVE_CADDY_LINK_REQUEST",
      meta: {
        entity: "CaddyLinkRequest",
        entityId: result.requestId,
        userId: result.userId,
        caddyId: result.caddyId,
        // phone 원문 금지 — 마스킹만 (요청 phone은 응답에 없음)
        phone: maskKrMobile(
          (
            await prisma.caddy.findUnique({
              where: { id: result.caddyId },
              select: { phoneNormalized: true },
            })
          )?.phoneNormalized ?? null
        ),
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
      "[POST /api/caddy-link-requests/:id/approve]",
      e?.message || e
    );
    return NextResponse.json(
      { error: "internal_error", message: "승인 실패" },
      { status: 500 }
    );
  }
}
