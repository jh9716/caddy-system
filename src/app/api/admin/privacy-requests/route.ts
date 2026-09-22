import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listPrivacyRequests } from "@/lib/privacyRequestInbox";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const items = await listPrivacyRequests(prisma);
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    console.error("[GET /api/admin/privacy-requests]", e);
    return NextResponse.json(
      { error: "internal_error", message: "목록 조회 실패" },
      { status: 500 }
    );
  }
}
