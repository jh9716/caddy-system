/**
 * Admin 1-user test push. Writes lastSuccessAt / lastFailureAt / stale delete
 * only when deliverWebPush is actually invoked.
 */
import type { PrismaClient } from "@prisma/client";
import {
  TEST_PUSH_BODY,
  TEST_PUSH_CONFIRM,
  TEST_PUSH_TITLE,
  TEST_PUSH_URL,
} from "@/lib/webPushTestConstants";
import { deliverWebPushMappings } from "@/lib/pushDelivery";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import { type WebPushSendFn } from "@/lib/webPushSender";

export class PushTestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "PushTestError";
  }
}

export type PushTestAggregate = {
  ok: boolean;
  sent: number;
  failed: number;
  removedStale: number;
  deliveries: number;
  error?: string;
};

const ALLOWED_ROLES = new Set(["caddy", "leader"]);

export function parseTestPushRequest(body: unknown): { userId: number; confirm: string } {
  if (Array.isArray(body)) {
    throw new PushTestError("invalid_target", "한 명만 지정할 수 있습니다.", 400);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (rec.userIds != null || rec.targets != null || rec.users != null || Array.isArray(rec.userId)) {
    throw new PushTestError("invalid_target", "한 명만 지정할 수 있습니다.", 400);
  }
  const confirm = String(rec.confirm ?? "");
  if (confirm !== TEST_PUSH_CONFIRM) {
    throw new PushTestError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  const n = typeof rec.userId === "number" ? rec.userId : Number(rec.userId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  return { userId: n, confirm };
}

export async function sendTestPushToUser(
  db: PrismaClient,
  userId: number,
  confirm: string,
  options?: { sendFn?: WebPushSendFn }
): Promise<PushTestAggregate> {
  if (confirm !== TEST_PUSH_CONFIRM) {
    throw new PushTestError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  if (!isWebPushSendConfigured()) {
    throw new PushTestError("push_not_configured", "알림 설정 준비 중", 503);
  }
  const creds = readWebPushSendCredentials();
  if (!creds) {
    throw new PushTestError("push_not_configured", "알림 설정 준비 중", 503);
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      caddy: { select: { employmentStatus: true } },
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      },
    },
  });
  if (!user) {
    throw new PushTestError("not_found", "대상을 찾을 수 없습니다.", 404);
  }
  if (!ALLOWED_ROLES.has(user.role)) {
    throw new PushTestError("invalid_target", "캐디 또는 조장만 테스트할 수 있습니다.", 400);
  }
  if (user.caddy && String(user.caddy.employmentStatus) === "RETIRED") {
    throw new PushTestError("retired", "퇴사한 캐디에게는 보낼 수 없습니다.", 400);
  }
  if (user.pushSubscriptions.length === 0) {
    return { ok: true, sent: 0, failed: 0, removedStale: 0, deliveries: 0, error: "no_subscription" };
  }

  const delivered = await deliverWebPushMappings(
    db,
    user.pushSubscriptions.map((sub) => ({
      id: sub.id,
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
    })),
    { title: TEST_PUSH_TITLE, body: TEST_PUSH_BODY, url: TEST_PUSH_URL },
    { sendFn: options?.sendFn, credentials: creds, concurrency: 1 }
  );
  return {
    ok: true,
    sent: delivered.sent,
    failed: delivered.failed,
    removedStale: delivered.removedStale,
    deliveries: delivered.deliveries,
  };
}

export function isPushTestStoreMissing(e: unknown): boolean {
  return isPushStoreMissing(e);
}
