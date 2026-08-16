import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAuthUser } from "@/lib/auth";
import {
  CaddyLinkRequestError,
  getMineCaddyLinkRequest,
  resolveSessionUser,
} from "@/lib/caddyLinkRequest";

export const dynamic = "force-dynamic";

/** GET — 본인 최신 연결 요청 (마스킹만) */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthUser(req);
    const username = auth?.username ?? null;
    const user = await resolveSessionUser(prisma, username);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const request = await getMineCaddyLinkRequest(prisma, user.id);
    return NextResponse.json({
      ok: true,
      linked: user.caddyId != null,
      caddyId: user.caddyId,
      request,
    });
  } catch (e) {
    if (e instanceof CaddyLinkRequestError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[GET /api/caddy-link-requests/mine]", e?.message || e);
    return NextResponse.json(
      { error: "internal_error", message: "조회 실패" },
      { status: 500 }
    );
  }
}
