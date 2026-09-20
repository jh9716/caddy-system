/**
 * Published daily-board Web Push V1.
 * Source: DailyBoardPublished only. No auto-send. No schema/migration.
 *
 * Fail-closed idempotency (no unique table / no migration):
 * - Console-only audit helper is NOT used. Prisma `Audit` INSERT/SELECT only.
 * - pg_advisory_xact_lock(date) serializes concurrent claims (not the
 *   durable key). Same date + different sourceDraftVersion can send again
 *   after the lock is released.
 * - Durable key: action=BOARD_PUSH_SEND + payload.date + payload.sourceDraftVersion.
 * - Same transaction: lock → SELECT existing row → INSERT status=STARTED → COMMIT.
 *   Claim is durable BEFORE any deliverWebPush.
 * - Crash before COMMIT: no row, retry may send (first send never started).
 * - Crash after COMMIT / partial send: STARTED|SENT|FAILED blocks the same
 *   version. Admin cannot full-resend to successes. No per-recipient retry in V1.
 * - no_recipients before claim: no Audit row (retry allowed if someone later
 *   subscribes). After claim, 0 targets writes NO_RECIPIENTS and blocks.
 * Audit has no UNIQUE constraint; the lock shrinks the race. A new table
 * would be required for constraint-level uniqueness — not in this PR.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { isYmd } from "@/lib/dailyBoardDraft";
import { getDailyBoardDraftVersion } from "@/lib/dailyBoardDraftService";
import { getDailyBoardPublished } from "@/lib/dailyBoardPublishedService";
import {
  resolvePublishedFreshness,
  type AlimtalkPublishedFreshness,
} from "@/lib/alimtalkPublishedFreshness";
import {
  BOARD_PUSH_ALREADY_SENT_MESSAGE,
  BOARD_PUSH_AUDIT_ACTION,
  BOARD_PUSH_AUDIT_ENTITY,
  BOARD_PUSH_CONCURRENCY,
  BOARD_PUSH_CONFIRM,
  BOARD_PUSH_LOCK_NS,
  BOARD_PUSH_NO_PUBLISHED_MESSAGE,
  BOARD_PUSH_STALE_MESSAGE,
} from "@/lib/boardPushConstants";
import { buildBoardPushPayload } from "@/lib/boardPushMessage";
import {
  uniqueAssignedCaddyIdsFromPublished,
} from "@/lib/boardPushRecipients";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { deliverWebPushMappings } from "@/lib/pushDelivery";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import { type WebPushSendFn } from "@/lib/webPushSender";

export class BoardPushError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BoardPushError";
  }
}

export type BoardPushCounts = {
  assignedCaddies: number;
  linkedUsers: number;
  subscribedUsers: number;
  subscriptions: number;
  noUser: number;
  noSubscription: number;
};

export type BoardPushPreview = {
  date: string;
  published: boolean;
  freshness: AlimtalkPublishedFreshness;
  canSend: boolean;
  sourceDraftVersion: number | null;
  currentDraftVersion: number | null;
  alreadySent: boolean;
  counts: BoardPushCounts;
};

export type BoardPushSendResult = {
  ok: boolean;
  recipients: number;
  subscriptions: number;
  sent: number;
  failed: number;
  removedStale: number;
  deliveries: number;
  error?: string;
};

type SubRow = {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const emptyCounts = (): BoardPushCounts => ({
  assignedCaddies: 0,
  linkedUsers: 0,
  subscribedUsers: 0,
  subscriptions: 0,
  noUser: 0,
  noSubscription: 0,
});

function ymdLockKey(ymd: string): number {
  return Number(ymd.replace(/-/g, ""));
}

export function parseBoardPushSendRequest(body: unknown): {
  date: string;
  confirm: string;
} {
  if (Array.isArray(body)) {
    throw new BoardPushError("invalid_target", "날짜 1개만 지정할 수 있습니다.", 400);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (
    rec.userIds != null ||
    rec.userId != null ||
    rec.targets != null ||
    rec.users != null ||
    rec.caddyIds != null ||
    rec.recipientIds != null
  ) {
    throw new BoardPushError(
      "invalid_target",
      "수신자는 서버가 게시본에서 계산합니다.",
      400
    );
  }
  const confirm = String(rec.confirm ?? "");
  if (confirm !== BOARD_PUSH_CONFIRM) {
    throw new BoardPushError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  const date = String(rec.date ?? "").trim();
  if (!isYmd(date)) {
    throw new BoardPushError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  return { date, confirm };
}

export function assertBoardPushCanSend(freshness: AlimtalkPublishedFreshness): void {
  if (freshness.status === "NO_PUBLISHED") {
    throw new BoardPushError(
      "NO_PUBLISHED",
      BOARD_PUSH_NO_PUBLISHED_MESSAGE,
      404,
      { freshness }
    );
  }
  if (freshness.status === "STALE") {
    throw new BoardPushError("STALE", BOARD_PUSH_STALE_MESSAGE, 409, { freshness });
  }
  if (!freshness.canSend) {
    throw new BoardPushError(
      freshness.status || "UNKNOWN",
      BOARD_PUSH_NO_PUBLISHED_MESSAGE,
      409,
      { freshness }
    );
  }
}

type AuditHit = { id: number; status: string };

async function findBoardPushAudit(
  db: PrismaClient | Prisma.TransactionClient,
  date: string,
  sourceDraftVersion: number
): Promise<AuditHit | null> {
  const rows = await db.$queryRaw<Array<{ id: number; payload: Prisma.JsonValue }>>`
    SELECT id, payload FROM "Audit"
    WHERE action = ${BOARD_PUSH_AUDIT_ACTION}
      AND entity = ${BOARD_PUSH_AUDIT_ENTITY}
      AND payload->>'date' = ${date}
      AND payload->>'sourceDraftVersion' = ${String(sourceDraftVersion)}
    ORDER BY id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  return { id: row.id, status: String(payload.status ?? "") };
}

async function claimBoardPushSend(
  db: PrismaClient,
  date: string,
  sourceDraftVersion: number
): Promise<{ auditId: number } | { duplicate: true; status: string }> {
  const lockKey = ymdLockKey(date);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      CAST(${BOARD_PUSH_LOCK_NS} AS integer),
      CAST(${lockKey} AS integer)
    )`;
    const existing = await findBoardPushAudit(tx, date, sourceDraftVersion);
    if (existing) {
      return { duplicate: true as const, status: existing.status };
    }
    const created = await tx.audit.create({
      data: {
        action: BOARD_PUSH_AUDIT_ACTION,
        entity: BOARD_PUSH_AUDIT_ENTITY,
        entityId: lockKey,
        payload: {
          date,
          sourceDraftVersion,
          status: "STARTED",
        },
      },
      select: { id: true },
    });
    return { auditId: created.id };
  });
}

async function finishBoardPushAudit(
  db: PrismaClient,
  auditId: number,
  payload: Record<string, unknown>
): Promise<void> {
  await db.audit.update({
    where: { id: auditId },
    data: { payload },
  });
}

export async function resolveEligibleBoardPushTargets(
  db: PrismaClient,
  assignedCaddyIds: number[]
): Promise<{
  counts: BoardPushCounts;
  subscriptions: SubRow[];
  recipientUserIds: number[];
}> {
  const assignedCaddies = assignedCaddyIds.length;
  if (assignedCaddyIds.length === 0) {
    return { counts: emptyCounts(), subscriptions: [], recipientUserIds: [] };
  }

  const caddies = await db.caddy.findMany({
    where: { id: { in: assignedCaddyIds } },
    select: { id: true, employmentStatus: true },
  });
  const eligibleIds = caddies
    .filter((c) => String(c.employmentStatus) !== "RETIRED")
    .map((c) => c.id);

  if (eligibleIds.length === 0) {
    return {
      counts: { ...emptyCounts(), assignedCaddies },
      subscriptions: [],
      recipientUserIds: [],
    };
  }

  const users = await db.user.findMany({
    where: { caddyId: { in: eligibleIds } },
    select: {
      id: true,
      caddyId: true,
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
      },
    },
  });

  const linkedByCaddy = new Set(
    users.map((u) => u.caddyId).filter((id): id is number => Number.isInteger(id))
  );
  const linkedUsers = users.length;
  const noUser = eligibleIds.filter((id) => !linkedByCaddy.has(id)).length;
  const subscribedUsers = users.filter((u) => u.pushSubscriptions.length > 0).length;
  const noSubscription = linkedUsers - subscribedUsers;
  const subscriptions = users.flatMap((u) => u.pushSubscriptions);
  const recipientUserIds = users
    .filter((u) => u.pushSubscriptions.length > 0)
    .map((u) => u.id);

  return {
    counts: {
      assignedCaddies,
      linkedUsers,
      subscribedUsers,
      subscriptions: subscriptions.length,
      noUser,
      noSubscription,
    },
    subscriptions,
    recipientUserIds,
  };
}

async function loadFreshness(date: string) {
  const [published, currentDraftVersion] = await Promise.all([
    getDailyBoardPublished(date),
    getDailyBoardDraftVersion(date),
  ]);
  const freshness = resolvePublishedFreshness({
    hasPublished: Boolean(published),
    publishedSourceDraftVersion: published?.sourceDraftVersion ?? null,
    currentDraftVersion,
  });
  return { published, currentDraftVersion, freshness };
}

export async function previewBoardPush(
  db: PrismaClient,
  date: string
): Promise<BoardPushPreview> {
  if (!isYmd(date)) {
    throw new BoardPushError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  const { published, currentDraftVersion, freshness } = await loadFreshness(date);
  if (!published) {
    return {
      date,
      published: false,
      freshness,
      canSend: false,
      sourceDraftVersion: null,
      currentDraftVersion,
      alreadySent: false,
      counts: emptyCounts(),
    };
  }

  const assignedIds = uniqueAssignedCaddyIdsFromPublished(published.payload);
  const { counts } = await resolveEligibleBoardPushTargets(db, assignedIds);
  const audit = await findBoardPushAudit(db, date, published.sourceDraftVersion);

  return {
    date,
    published: true,
    freshness,
    canSend: freshness.canSend,
    sourceDraftVersion: published.sourceDraftVersion,
    currentDraftVersion,
    alreadySent: Boolean(audit),
    counts,
  };
}

export async function sendBoardPush(
  db: PrismaClient,
  input: { date: string; confirm: string },
  options?: { sendFn?: WebPushSendFn }
): Promise<BoardPushSendResult> {
  if (input.confirm !== BOARD_PUSH_CONFIRM) {
    throw new BoardPushError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  if (!isYmd(input.date)) {
    throw new BoardPushError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  if (!isWebPushSendConfigured()) {
    throw new BoardPushError("push_not_configured", "알림 설정 준비 중", 503);
  }
  const creds = readWebPushSendCredentials();
  if (!creds) {
    throw new BoardPushError("push_not_configured", "알림 설정 준비 중", 503);
  }

  const first = await loadFreshness(input.date);
  assertBoardPushCanSend(first.freshness);
  if (!first.published) {
    throw new BoardPushError(
      "NO_PUBLISHED",
      BOARD_PUSH_NO_PUBLISHED_MESSAGE,
      404,
      { freshness: first.freshness }
    );
  }

  const preTargets = await resolveEligibleBoardPushTargets(
    db,
    uniqueAssignedCaddyIdsFromPublished(first.published.payload)
  );
  if (preTargets.subscriptions.length === 0) {
    return {
      ok: true,
      recipients: 0,
      subscriptions: 0,
      sent: 0,
      failed: 0,
      removedStale: 0,
      deliveries: 0,
      error: "no_recipients",
    };
  }

  const claim = await claimBoardPushSend(
    db,
    input.date,
    first.published.sourceDraftVersion
  );
  if ("duplicate" in claim) {
    throw new BoardPushError(
      "already_sent",
      BOARD_PUSH_ALREADY_SENT_MESSAGE,
      409
    );
  }

  try {
    const again = await loadFreshness(input.date);
    assertBoardPushCanSend(again.freshness);
    if (!again.published) {
      throw new BoardPushError(
        "NO_PUBLISHED",
        BOARD_PUSH_NO_PUBLISHED_MESSAGE,
        404,
        { freshness: again.freshness }
      );
    }
    if (again.published.sourceDraftVersion !== first.published.sourceDraftVersion) {
      throw new BoardPushError("STALE", BOARD_PUSH_STALE_MESSAGE, 409, {
        freshness: again.freshness,
      });
    }

    const { counts, subscriptions, recipientUserIds } =
      await resolveEligibleBoardPushTargets(
        db,
        uniqueAssignedCaddyIdsFromPublished(again.published.payload)
      );

    if (subscriptions.length === 0) {
      await finishBoardPushAudit(db, claim.auditId, {
        date: input.date,
        sourceDraftVersion: again.published.sourceDraftVersion,
        status: "NO_RECIPIENTS",
      });
      return {
        ok: true,
        recipients: 0,
        subscriptions: 0,
        sent: 0,
        failed: 0,
        removedStale: 0,
        deliveries: 0,
        error: "no_recipients",
      };
    }

    const payload = buildBoardPushPayload(input.date);
    const delivered = await deliverWebPushMappings(db, subscriptions, payload, {
      sendFn: options?.sendFn,
      credentials: creds,
      concurrency: BOARD_PUSH_CONCURRENCY,
    });

    await finishBoardPushAudit(db, claim.auditId, {
      date: input.date,
      sourceDraftVersion: again.published.sourceDraftVersion,
      status: "SENT",
      recipients: recipientUserIds.length,
      subscriptions: counts.subscriptions,
      sent: delivered.sent,
      failed: delivered.failed,
      removedStale: delivered.removedStale,
      deliveries: delivered.deliveries,
    });

    return {
      ok: true,
      recipients: recipientUserIds.length,
      subscriptions: counts.subscriptions,
      sent: delivered.sent,
      failed: delivered.failed,
      removedStale: delivered.removedStale,
      deliveries: delivered.deliveries,
    };
  } catch (e) {
    const code = e instanceof BoardPushError ? e.code : "internal_error";
    await finishBoardPushAudit(db, claim.auditId, {
      date: input.date,
      sourceDraftVersion: first.published.sourceDraftVersion,
      status: "FAILED",
      error: code,
    }).catch(() => undefined);
    throw e;
  }
}

export function isBoardPushStoreMissing(e: unknown): boolean {
  return isPushStoreMissing(e);
}
