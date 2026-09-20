/**
 * CourseReport Web Push V1.
 * Auto-send on create (NEW → admin subscriptions) and status change
 * (STATUS → authorUserId subscriptions). No UI send button.
 *
 * Fail-closed idempotency (no schema/migration):
 * - Prisma `Audit` INSERT/SELECT only. No extra CourseReport column.
 * - pg_advisory_xact_lock(reportId) serializes concurrent claims.
 * - Durable key: action=COURSE_REPORT_PUSH_SEND + payload.kind + payload.reportId
 *   (+ payload.status for STATUS).
 * - Same transaction: lock → SELECT existing → INSERT claim=STARTED → COMMIT.
 * - Claim is durable BEFORE any deliverWebPush.
 * - Duplicate event: skip resend. Same STATUS click does not send again.
 * - Different STATUS value is a new event (1 send).
 * - Credentials missing: skip without claim (fail-safe, no throw).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COURSE_REPORT_STATUSES,
  type CourseReportStatusCode,
} from "@/lib/courseReportConstants";
import {
  COURSE_REPORT_PUSH_AUDIT_ACTION,
  COURSE_REPORT_PUSH_AUDIT_ENTITY,
  COURSE_REPORT_PUSH_CONCURRENCY,
  COURSE_REPORT_PUSH_LOCK_NS,
} from "@/lib/courseReportPushConstants";
import {
  buildCourseReportNewPushPayload,
  buildCourseReportStatusPushPayload,
} from "@/lib/courseReportPushMessage";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { deliverWebPushMappings } from "@/lib/pushDelivery";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import { normalizeAppRole } from "@/lib/sessionCookies";
import {
  type WebPushPayload,
  type WebPushSendFn,
} from "@/lib/webPushSender";

export type CourseReportPushKind = "NEW" | "STATUS";

export type CourseReportPushEvent =
  | { kind: "NEW"; reportId: number }
  | { kind: "STATUS"; reportId: number; status: CourseReportStatusCode };

export type CourseReportPushResult = {
  ok: boolean;
  skipped?: "not_configured" | "already_sent" | "same_status" | "not_found";
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

type ReportRow = {
  id: number;
  authorUserId: number;
  title: string;
  course: string;
  category: string;
  status: string;
  deletedAt: Date | null;
};

const emptyResult = (
  extra?: Partial<CourseReportPushResult>
): CourseReportPushResult => ({
  ok: true,
  recipients: 0,
  subscriptions: 0,
  sent: 0,
  failed: 0,
  removedStale: 0,
  deliveries: 0,
  ...extra,
});

function isStatusCode(value: string): value is CourseReportStatusCode {
  return (COURSE_REPORT_STATUSES as readonly string[]).includes(value);
}

async function findCourseReportPushAudit(
  db: PrismaClient | Prisma.TransactionClient,
  event: CourseReportPushEvent
): Promise<{ id: number } | null> {
  const reportId = String(event.reportId);
  const rows =
    event.kind === "NEW"
      ? await db.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM "Audit"
          WHERE action = ${COURSE_REPORT_PUSH_AUDIT_ACTION}
            AND entity = ${COURSE_REPORT_PUSH_AUDIT_ENTITY}
            AND payload->>'kind' = 'NEW'
            AND payload->>'reportId' = ${reportId}
          ORDER BY id DESC
          LIMIT 1
        `
      : await db.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM "Audit"
          WHERE action = ${COURSE_REPORT_PUSH_AUDIT_ACTION}
            AND entity = ${COURSE_REPORT_PUSH_AUDIT_ENTITY}
            AND payload->>'kind' = 'STATUS'
            AND payload->>'reportId' = ${reportId}
            AND payload->>'status' = ${event.status}
          ORDER BY id DESC
          LIMIT 1
        `;
  return rows[0] ?? null;
}

function claimPayload(event: CourseReportPushEvent): Prisma.InputJsonValue {
  if (event.kind === "NEW") {
    return { reportId: event.reportId, kind: "NEW", claim: "STARTED" };
  }
  return {
    reportId: event.reportId,
    kind: "STATUS",
    status: event.status,
    claim: "STARTED",
  };
}

async function claimCourseReportPushSend(
  db: PrismaClient,
  event: CourseReportPushEvent
): Promise<{ auditId: number } | { duplicate: true }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      CAST(${COURSE_REPORT_PUSH_LOCK_NS} AS integer),
      CAST(${event.reportId} AS integer)
    )`;
    const existing = await findCourseReportPushAudit(tx, event);
    if (existing) return { duplicate: true as const };
    const created = await tx.audit.create({
      data: {
        action: COURSE_REPORT_PUSH_AUDIT_ACTION,
        entity: COURSE_REPORT_PUSH_AUDIT_ENTITY,
        entityId: event.reportId,
        payload: claimPayload(event),
      },
      select: { id: true },
    });
    return { auditId: created.id };
  });
}

async function finishCourseReportPushAudit(
  db: PrismaClient,
  auditId: number,
  event: CourseReportPushEvent,
  extra: Record<string, unknown>
): Promise<void> {
  const base =
    event.kind === "NEW"
      ? { reportId: event.reportId, kind: "NEW" }
      : { reportId: event.reportId, kind: "STATUS", status: event.status };
  await db.audit.update({
    where: { id: auditId },
    data: { payload: { ...base, ...extra } },
  });
}

export async function resolveCourseReportNewPushTargets(
  db: PrismaClient
): Promise<{ subscriptions: SubRow[]; recipientUserIds: number[] }> {
  const users = await db.user.findMany({
    select: {
      id: true,
      role: true,
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
      },
    },
  });
  const admins = users.filter((u) => normalizeAppRole(u.role) === "admin");
  const subscriptions = admins.flatMap((u) => u.pushSubscriptions);
  const recipientUserIds = admins
    .filter((u) => u.pushSubscriptions.length > 0)
    .map((u) => u.id);
  return { subscriptions, recipientUserIds };
}

export async function resolveCourseReportStatusPushTargets(
  db: PrismaClient,
  authorUserId: number
): Promise<{ subscriptions: SubRow[]; recipientUserIds: number[] }> {
  if (!Number.isInteger(authorUserId) || authorUserId <= 0) {
    return { subscriptions: [], recipientUserIds: [] };
  }
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: authorUserId, enabled: true },
    select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
  });
  return {
    subscriptions,
    recipientUserIds: subscriptions.length > 0 ? [authorUserId] : [],
  };
}

async function loadReport(
  db: PrismaClient,
  reportId: number
): Promise<ReportRow | null> {
  if (!Number.isInteger(reportId) || reportId <= 0) return null;
  return db.courseReport.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      authorUserId: true,
      title: true,
      course: true,
      category: true,
      status: true,
      deletedAt: true,
    },
  });
}

async function deliverToSubscriptions(
  db: PrismaClient,
  subscriptions: SubRow[],
  payload: WebPushPayload,
  sendFn: WebPushSendFn | undefined,
  creds: NonNullable<ReturnType<typeof readWebPushSendCredentials>>
): Promise<{ sent: number; failed: number; removedStale: number; deliveries: number }> {
  return deliverWebPushMappings(db, subscriptions, payload, {
    sendFn,
    credentials: creds,
    concurrency: COURSE_REPORT_PUSH_CONCURRENCY,
  });
}

export async function sendCourseReportPush(
  db: PrismaClient,
  event: CourseReportPushEvent,
  options?: { sendFn?: WebPushSendFn }
): Promise<CourseReportPushResult> {
  try {
    if (!options?.sendFn && !isWebPushSendConfigured()) {
      return emptyResult({ skipped: "not_configured" });
    }
    const creds = readWebPushSendCredentials();
    if (!creds) {
      return emptyResult({ skipped: "not_configured" });
    }

    const report = await loadReport(db, event.reportId);
    if (!report || report.deletedAt) {
      return emptyResult({ skipped: "not_found", error: "not_found" });
    }

    const targets =
      event.kind === "NEW"
        ? await resolveCourseReportNewPushTargets(db)
        : await resolveCourseReportStatusPushTargets(db, report.authorUserId);

    const claim = await claimCourseReportPushSend(db, event);
    if ("duplicate" in claim) {
      return emptyResult({ skipped: "already_sent" });
    }

    try {
      const payload: WebPushPayload =
        event.kind === "NEW"
          ? buildCourseReportNewPushPayload({
              reportId: report.id,
              category: report.category,
              course: report.course,
              title: report.title,
            })
          : buildCourseReportStatusPushPayload({
              reportId: report.id,
              status: event.status,
              title: report.title,
            });

      if (targets.subscriptions.length === 0) {
        await finishCourseReportPushAudit(db, claim.auditId, event, {
          claim: "NO_RECIPIENTS",
          recipients: 0,
          subscriptions: 0,
          deliveries: 0,
        });
        return emptyResult({ error: "no_recipients" });
      }

      const delivered = await deliverToSubscriptions(
        db,
        targets.subscriptions,
        payload,
        options?.sendFn,
        creds
      );
      await finishCourseReportPushAudit(db, claim.auditId, event, {
        claim: "SENT",
        recipients: targets.recipientUserIds.length,
        subscriptions: targets.subscriptions.length,
        sent: delivered.sent,
        failed: delivered.failed,
        removedStale: delivered.removedStale,
        deliveries: delivered.deliveries,
      });
      return {
        ok: true,
        recipients: targets.recipientUserIds.length,
        subscriptions: targets.subscriptions.length,
        sent: delivered.sent,
        failed: delivered.failed,
        removedStale: delivered.removedStale,
        deliveries: delivered.deliveries,
      };
    } catch (e) {
      await finishCourseReportPushAudit(db, claim.auditId, event, {
        claim: "FAILED",
        error: e instanceof Error ? e.name : "internal_error",
      }).catch(() => undefined);
      return emptyResult({ ok: false, error: "internal_error" });
    }
  } catch (e) {
    if (isPushStoreMissing(e)) {
      return emptyResult({ ok: false, error: "push_store_missing" });
    }
    return emptyResult({ ok: false, error: "internal_error" });
  }
}

/** Best-effort. Never throws to the CourseReport write path. */
export async function notifyCourseReportCreated(
  db: PrismaClient,
  reportId: number,
  options?: { sendFn?: WebPushSendFn }
): Promise<CourseReportPushResult> {
  try {
    return await sendCourseReportPush(db, { kind: "NEW", reportId }, options);
  } catch {
    return emptyResult({ ok: false, error: "internal_error" });
  }
}

/** Best-effort. Same status is a no-op (no claim, no send). */
export async function notifyCourseReportStatusChanged(
  db: PrismaClient,
  input: {
    reportId: number;
    previousStatus: string;
    nextStatus: string;
  },
  options?: { sendFn?: WebPushSendFn }
): Promise<CourseReportPushResult> {
  try {
    if (input.previousStatus === input.nextStatus) {
      return emptyResult({ skipped: "same_status" });
    }
    if (!isStatusCode(input.nextStatus)) {
      return emptyResult({ skipped: "not_found", error: "invalid_status" });
    }
    return await sendCourseReportPush(
      db,
      { kind: "STATUS", reportId: input.reportId, status: input.nextStatus },
      options
    );
  } catch {
    return emptyResult({ ok: false, error: "internal_error" });
  }
}
