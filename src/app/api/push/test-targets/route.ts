import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { searchPushTestTargets } from "@/lib/webPushTestTargets";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const q = req.nextUrl.searchParams.get("q");
  try {
    const results = await searchPushTestTargets(prisma, q);
    return NextResponse.json({ results });
  } catch (e) {
    if (isPushStoreMissing(e)) {
      return NextResponse.json({ results: [] });
    }
    console.error("[ /api/push/test-targets GET ]", "failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
