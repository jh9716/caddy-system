import type { PrismaClient } from "@prisma/client";
import {
  NOTICE_PUSH_CONFIRM,
  NOTICE_PUSH_DELIVERY_FAILED_MESSAGE,
} from "@/lib/noticeConstants";
import { isNoticeInPublishWindow } from "@/lib/noticeTarget";
import { NoticePushError, sendNoticePush } from "@/lib/noticePush";

export type NoticeAutoPushSkipReason =
  | "disabled"
  | "scheduled"
  | "outside_window";

export type NoticeAutoPushDecision =
  | { send: false; reason: NoticeAutoPushSkipReason }
  | { send: true };

export type NoticeAutoPushResult = {
  attempted: boolean;
  skipped: NoticeAutoPushSkipReason | null;
  ok: boolean;
  error?: string;
  message?: string;
  sent?: number;
  failed?: number;
};

export function parseNoticeSendPushFlag(
  body: unknown,
  defaultValue = false
): boolean {
  if (!body || typeof body !== "object") return defaultValue;
  const rec = body as Record<string, unknown>;
  if (rec.sendPush === undefined) return defaultValue;
  return rec.sendPush === true || rec.sendPush === "true";
}

export function decideNoticeAutoPush(input: {
  requested: boolean;
  publishStartAt?: Date | null;
  publishEndAt?: Date | null;
  now?: Date;
}): NoticeAutoPushDecision {
  if (!input.requested) return { send: false, reason: "disabled" };
  const now = input.now ?? new Date();
  if (
    !isNoticeInPublishWindow(
      {
        publishStartAt: input.publishStartAt ?? null,
        publishEndAt: input.publishEndAt ?? null,
      },
      now
    )
  ) {
    if (
      input.publishStartAt &&
      input.publishStartAt.getTime() > now.getTime()
    ) {
      return { send: false, reason: "scheduled" };
    }
    return { send: false, reason: "outside_window" };
  }
  return { send: true };
}

let sendOverride: typeof sendNoticePush | null = null;

export function setNoticeCreatePushSenderForTests(
  fn: typeof sendNoticePush | null
) {
  sendOverride = fn;
}

export async function runNoticeCreatePush(input: {
  db: PrismaClient;
  noticeId: number;
  requested: boolean;
  publishStartAt?: Date | null;
  publishEndAt?: Date | null;
  actorUserId: number | null;
  now?: Date;
  send?: typeof sendNoticePush;
}): Promise<NoticeAutoPushResult> {
  const decision = decideNoticeAutoPush({
    requested: input.requested,
    publishStartAt: input.publishStartAt,
    publishEndAt: input.publishEndAt,
    now: input.now,
  });
  if (!decision.send) {
    return { attempted: false, skipped: decision.reason, ok: true };
  }

  const send = input.send ?? sendOverride ?? sendNoticePush;
  try {
    const result = await send(
      input.db,
      {
        noticeId: input.noticeId,
        confirm: NOTICE_PUSH_CONFIRM,
        actorUserId: input.actorUserId,
      }
    );
    return {
      attempted: true,
      skipped: null,
      ok: result.ok !== false,
      error: result.error,
      sent: result.sent,
      failed: result.failed,
      message:
        result.error === "no_recipients"
          ? "구독 중인 캐디가 없습니다."
          : result.error === "delivery_failed"
            ? NOTICE_PUSH_DELIVERY_FAILED_MESSAGE
            : undefined,
    };
  } catch (e) {
    const message =
      e instanceof NoticePushError
        ? e.message
        : "푸시 알림 발송에 실패했습니다. 공지는 저장되었습니다.";
    const error = e instanceof NoticePushError ? e.code : "push_failed";
    return {
      attempted: true,
      skipped: null,
      ok: false,
      error,
      message,
    };
  }
}
