/**
 * Notice Web Push V1.
 * Recipients: server-computed from Notice target. No client userIds.
 *
 * Fail-closed idempotency:
 * - Durable key: Notice.pushSentAt / pushSentByUserId.
 * - Same transaction: pg_advisory_xact_lock(noticeId) → SELECT → SET pushSentAt → COMMIT.
 * - Claim is durable BEFORE any deliverWebPush.
 * - Crash before COMMIT: pushSentAt null, retry may send (first send never started).
 * - Crash after COMMIT / partial send: pushSentAt blocks the same notice.
 *   Admin cannot full-resend. No per-recipient retry in V1.
 * - no_recipients before claim: pushSentAt stays null (retry allowed if someone later
 *   subscribes). After claim, 0 targets still keep pushSentAt.
 * Optional Audit NOTICE_PUSH_SEND is aggregates only — not the idempotency key.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "@/lib/boardPushRecipients";
import {
  NOTICE_PUSH_ALREADY_SENT_MESSAGE,
  NOTICE_PUSH_AUDIT_ACTION,
  NOTICE_PUSH_AUDIT_ENTITY,
  NOTICE_PUSH_CONCURRENCY,
  NOTICE_PUSH_CONFIRM,
  NOTICE_PUSH_LOCK_NS,
  NOTICE_PUSH_OUTSIDE_WINDOW_MESSAGE,
} from "@/lib/noticeConstants";
import { buildNoticePushPayload } from "@/lib/noticePushMessage";
import {
  caddyTargetWhere,
  isNoticeInPublishWindow,
} from "@/lib/noticeTarget";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import {
  deliverWebPush,
  type WebPushSendFn,
} from "@/lib/webPushSender";

export class NoticePushError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NoticePushError";
  }
}

export type NoticePushCounts = {
  eligibleUsers: number;
  subscribedUsers: number;
  subscriptions: number;
  noSubscription: number;
};

export type NoticePushPreview = {
  noticeId: number;
  targetType: string;
  targetValue: string | null;
  counts: NoticePushCounts;
  canSend: boolean;
  alreadySent: boolean;
};

export type NoticePushSendResult = {
  ok: boolean;
  recipients: number;
  subscriptions: number;
  sent: number;
  failed: number;
  removedStale: number;
  error?: string;
};

type SubRow = {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type NoticePushRow = {
  id: number;
  title: string;
  important: boolean;
  targetType: string;
  targetValue: string | null;
  publishStartAt: Date | null;
  publishEndAt: Date | null;
  pushSentAt: Date | null;
};

const emptyCounts = (): NoticePushCounts => ({
  eligibleUsers: 0,
  subscribedUsers: 0,
  subscriptions: 0,
  noSubscription: 0,
});

const noticePushSelect = {
  id: true,
  title: true,
  important: true,
  targetType: true,
  targetValue: true,
  publishStartAt: true,
  publishEndAt: true,
  pushSentAt: true,
} as const;

export function parseNoticePushSendRequest(body: unknown): {
  noticeId: number;
  confirm: string;
} {
  if (Array.isArray(body)) {
    throw new NoticePushError("invalid_target", "공지 1개만 지정할 수 있습니다.", 400);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (
    rec.userIds != null ||
    rec.userId != null ||
    rec.targets != null ||
    rec.users != null ||
    rec.caddyIds != null ||
    rec.recipientIds != null ||
    rec.batch != null
  ) {
    throw new NoticePushError(
      "invalid_target",
      "수신자는 서버가 공지 대상으로 계산합니다.",
      400
    );
  }
  const confirm = String(rec.confirm ?? "");
  if (confirm !== NOTICE_PUSH_CONFIRM) {
    throw new NoticePushError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  const noticeId = Number(rec.noticeId);
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    throw new NoticePushError("invalid_notice", "noticeId가 필요합니다.", 400);
  }
  return { noticeId, confirm };
}

export async function resolveEligibleNoticePushTargets(
  db: PrismaClient,
  notice: { targetType: string; targetValue: string | null }
): Promise<{
  counts: NoticePushCounts;
  subscriptions: SubRow[];
  recipientUserIds: number[];
}> {
  const caddies = await db.caddy.findMany({
    where: caddyTargetWhere(notice),
    select: { id: true },
  });
  const eligibleCaddyIds = caddies.map((c) => c.id);
  if (eligibleCaddyIds.length === 0) {
    return { counts: emptyCounts(), subscriptions: [], recipientUserIds: [] };
  }

  const users = await db.user.findMany({
    where: { caddyId: { in: eligibleCaddyIds } },
    select: {
      id: true,
      caddyId: true,
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
      },
    },
  });

  const eligibleUsers = users.length;
  const subscribedUsers = users.filter((u) => u.pushSubscriptions.length > 0).length;
  const noSubscription = eligibleUsers - subscribedUsers;
  const subscriptions = users.flatMap((u) => u.pushSubscriptions);
  const recipientUserIds = [
    ...new Set(
      users.filter((u) => u.pushSubscriptions.length > 0).map((u) => u.id)
    ),
  ];

  return {
    counts: {
      eligibleUsers,
      subscribedUsers,
      subscriptions: subscriptions.length,
      noSubscription,
    },
    subscriptions,
    recipientUserIds,
  };
}

async function loadNotice(
  db: PrismaClient | Prisma.TransactionClient,
  noticeId: number
): Promise<NoticePushRow | null> {
  return db.notice.findUnique({
    where: { id: noticeId },
    select: noticePushSelect,
  });
}

function assertInWindow(notice: NoticePushRow, now = new Date()): void {
  if (!isNoticeInPublishWindow(notice, now)) {
    throw new NoticePushError(
      "outside_window",
      NOTICE_PUSH_OUTSIDE_WINDOW_MESSAGE,
      409
    );
  }
}

async function claimNoticePushSend(
  db: PrismaClient,
  noticeId: number,
  actorUserId: number | null
): Promise<{ claimed: true } | { duplicate: true }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      CAST(${NOTICE_PUSH_LOCK_NS} AS integer),
      CAST(${noticeId} AS integer)
    )`;
    const row = await loadNotice(tx, noticeId);
    if (!row) {
      throw new NoticePushError("not_found", "공지를 찾을 수 없습니다.", 404);
    }
    if (row.pushSentAt) {
      return { duplicate: true as const };
    }
    await tx.notice.update({
      where: { id: noticeId },
      data: {
        pushSentAt: new Date(),
        pushSentByUserId: actorUserId,
      },
    });
    return { claimed: true as const };
  });
}

async function writeNoticePushAudit(
  db: PrismaClient,
  noticeId: number,
  payload: Record<string, unknown>
): Promise<void> {
  await db.audit.create({
    data: {
      action: NOTICE_PUSH_AUDIT_ACTION,
      entity: NOTICE_PUSH_AUDIT_ENTITY,
      entityId: noticeId,
      payload,
    },
  }).catch(() => undefined);
}

export async function previewNoticePush(
  db: PrismaClient,
  noticeId: number
): Promise<NoticePushPreview> {
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    throw new NoticePushError("invalid_notice", "noticeId가 필요합니다.", 400);
  }
  const notice = await loadNotice(db, noticeId);
  if (!notice) {
    throw new NoticePushError("not_found", "공지를 찾을 수 없습니다.", 404);
  }
  const { counts } = await resolveEligibleNoticePushTargets(db, notice);
  const alreadySent = Boolean(notice.pushSentAt);
  const inWindow = isNoticeInPublishWindow(notice);
  return {
    noticeId: notice.id,
    targetType: notice.targetType,
    targetValue: notice.targetValue,
    counts,
    canSend: inWindow && !alreadySent,
    alreadySent,
  };
}

export async function sendNoticePush(
  db: PrismaClient,
  input: { noticeId: number; confirm: string; actorUserId: number | null },
  options?: { sendFn?: WebPushSendFn }
): Promise<NoticePushSendResult> {
  if (input.confirm !== NOTICE_PUSH_CONFIRM) {
    throw new NoticePushError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  if (!Number.isInteger(input.noticeId) || input.noticeId <= 0) {
    throw new NoticePushError("invalid_notice", "noticeId가 필요합니다.", 400);
  }
  if (!isWebPushSendConfigured()) {
    throw new NoticePushError("push_not_configured", "알림 설정 준비 중", 503);
  }
  const creds = readWebPushSendCredentials();
  if (!creds) {
    throw new NoticePushError("push_not_configured", "알림 설정 준비 중", 503);
  }

  const first = await loadNotice(db, input.noticeId);
  if (!first) {
    throw new NoticePushError("not_found", "공지를 찾을 수 없습니다.", 404);
  }
  assertInWindow(first);
  if (first.pushSentAt) {
    throw new NoticePushError(
      "already_sent",
      NOTICE_PUSH_ALREADY_SENT_MESSAGE,
      409
    );
  }

  const preTargets = await resolveEligibleNoticePushTargets(db, first);
  if (preTargets.subscriptions.length === 0) {
    return {
      ok: true,
      recipients: 0,
      subscriptions: 0,
      sent: 0,
      failed: 0,
      removedStale: 0,
      error: "no_recipients",
    };
  }

  const claim = await claimNoticePushSend(db, input.noticeId, input.actorUserId);
  if ("duplicate" in claim) {
    throw new NoticePushError(
      "already_sent",
      NOTICE_PUSH_ALREADY_SENT_MESSAGE,
      409
    );
  }

  try {
    const again = await loadNotice(db, input.noticeId);
    if (!again) {
      throw new NoticePushError("not_found", "공지를 찾을 수 없습니다.", 404);
    }
    assertInWindow(again);

    const { counts, subscriptions, recipientUserIds } =
      await resolveEligibleNoticePushTargets(db, again);

    if (subscriptions.length === 0) {
      await writeNoticePushAudit(db, input.noticeId, {
        noticeId: input.noticeId,
        status: "NO_RECIPIENTS",
        recipients: 0,
        subscriptions: 0,
      });
      return {
        ok: true,
        recipients: 0,
        subscriptions: 0,
        sent: 0,
        failed: 0,
        removedStale: 0,
        error: "no_recipients",
      };
    }

    const payload = buildNoticePushPayload({
      noticeId: again.id,
      title: again.title,
      important: again.important,
    });
    let sent = 0;
    let failed = 0;
    let removedStale = 0;

    await mapWithConcurrency(subscriptions, NOTICE_PUSH_CONCURRENCY, async (sub) => {
      const result = await deliverWebPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        payload,
        { sendFn: options?.sendFn, credentials: creds }
      );
      if (result === "sent") {
        await db.pushSubscription.update({
          where: { id: sub.id },
          data: { lastSuccessAt: new Date() },
        });
        sent += 1;
      } else if (result === "gone") {
        await db.pushSubscription.delete({ where: { id: sub.id } });
        removedStale += 1;
      } else {
        await db.pushSubscription.update({
          where: { id: sub.id },
          data: { lastFailureAt: new Date() },
        });
        failed += 1;
      }
    });

    await writeNoticePushAudit(db, input.noticeId, {
      noticeId: input.noticeId,
      status: "SENT",
      recipients: recipientUserIds.length,
      subscriptions: counts.subscriptions,
      sent,
      failed,
      removedStale,
    });

    return {
      ok: true,
      recipients: recipientUserIds.length,
      subscriptions: counts.subscriptions,
      sent,
      failed,
      removedStale,
    };
  } catch (e) {
    const code = e instanceof NoticePushError ? e.code : "internal_error";
    await writeNoticePushAudit(db, input.noticeId, {
      noticeId: input.noticeId,
      status: "FAILED",
      error: code,
    });
    throw e;
  }
}

export function isNoticePushStoreMissing(e: unknown): boolean {
  return isPushStoreMissing(e);
}
