/**
 * Client-safe create/edit auto-push planning.
 * No Prisma, no FCM, no secrets.
 */

export type NoticeClientAutoPushPlan = {
  scheduled: boolean;
  sendOnCreate: boolean;
  sendAfterPhotos: boolean;
};

export function parseNoticeDateTime(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

export function isFutureNoticeStart(
  value: string | Date | null | undefined,
  now: Date = new Date()
): boolean {
  const start = parseNoticeDateTime(value);
  return Boolean(start && start.getTime() > now.getTime());
}

export function planNoticeClientAutoPush(input: {
  sendPushRequested: boolean;
  pendingPhotoCount: number;
  publishStartAt?: string | Date | null;
  now?: Date;
}): NoticeClientAutoPushPlan {
  const scheduled = isFutureNoticeStart(input.publishStartAt, input.now);
  if (scheduled || !input.sendPushRequested) {
    return { scheduled, sendOnCreate: false, sendAfterPhotos: false };
  }
  if (input.pendingPhotoCount > 0) {
    return { scheduled: false, sendOnCreate: false, sendAfterPhotos: true };
  }
  return { scheduled: false, sendOnCreate: true, sendAfterPhotos: false };
}
