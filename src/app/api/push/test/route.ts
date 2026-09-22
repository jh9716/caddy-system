import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePushSubscriptionUserId } from "@/lib/adminPushUser";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  PushTestError,
  isPushTestStoreMissing,
  parseTestPushRequest,
  sendNativeTestPushToSelf,
  sendTestPushToUser,
} from "@/lib/webPushTestSend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requireWebTarget(userId: number | null): number {
  if (userId == null) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  return userId;
}

/** Native test target is the signed-in admin's own User. Client userId cannot redirect it. */
async function sendNativeTestToSessionAdmin(req: NextRequest, requestedUserId: number | null) {
  const auth = await resolveAuthUser(req);
  if (!auth || auth.role !== "admin") {
    throw new PushTestError("invalid_target", "본인 Android 알림만 테스트할 수 있습니다.", 400);
  }
  const targetUserId = await resolvePushSubscriptionUserId(prisma, {
    role: auth.role,
    userId: auth.userId,
    username: auth.username,
  });
  if (targetUserId == null) {
    throw new PushTestError("invalid_target", "본인 Android 알림만 테스트할 수 있습니다.", 400);
  }
  if (requestedUserId != null && requestedUserId !== targetUserId) {
    throw new PushTestError("invalid_target", "본인에게만 보낼 수 있습니다.", 400);
  }
  return sendNativeTestPushToSelf(prisma, targetUserId);
}

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
    const parsed = parseTestPushRequest(body);
    const result =
      parsed.channel === "native"
        ? await sendNativeTestToSessionAdmin(req, parsed.userId)
        : await sendTestPushToUser(prisma, requireWebTarget(parsed.userId), parsed.confirm);
    return NextResponse.json({
      ok: result.ok,
      sent: result.sent,
      failed: result.failed,
      removedStale: result.removedStale,
      ...(typeof result.deliveries === "number" ? { deliveries: result.deliveries } : {}),
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
