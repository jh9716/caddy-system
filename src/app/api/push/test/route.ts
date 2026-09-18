import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  PushTestError,
  isPushTestStoreMissing,
  parseTestPushRequest,
  sendTestPushToUser,
} from "@/lib/webPushTestSend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function logTest(op: string, e: unknown) {
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code ?? "")
      : "";
  console.error(`[ /api/push/test ${op} ]`, code || "failed");
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const body = await req.json().catch(() => ({}));
  try {
    const { userId, confirm } = parseTestPushRequest(body);
    const result = await sendTestPushToUser(prisma, userId, confirm);
    return NextResponse.json({
      ok: result.ok,
      sent: result.sent,
      failed: result.failed,
      removedStale: result.removedStale,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    if (e instanceof PushTestError) {
      return NextResponse.json({ error: e.code }, { status: e.status });
    }
    if (isPushTestStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    logTest("POST", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
