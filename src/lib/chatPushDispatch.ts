/**
 * One chat message → one backend dispatch.
 * Batch-resolve prefs/tokens, then reuse existing native/web senders.
 */
import type { PrismaClient } from "@prisma/client";
import { buildChatPushPayload } from "@/lib/chatPushMessage";
import {
  candidateUserIdsForRoom,
  exclusiveChatWebPushRows,
  selectChatPushRecipients,
  type ChatPushEvent,
} from "@/lib/chatPushRecipients";
import { resolveChatNotifyMode, type ChatNotifyMode } from "@/lib/chatNotificationPref";
import {
  CHAT_USERS_ALL_TAKE,
  isInvitableChatUser,
  type ChatUserRow,
} from "@/lib/chatUsers";
import {
  canAttemptNativePushSend,
  deliverNativePushTokens,
  loadEnabledDevicePushTokens,
  type NativePushSendFn,
} from "@/lib/nativePushDelivery";
import { selectWebPushMappingsAfterNativeSuccess } from "@/lib/pushChannelOverlap";
import { deliverWebPushMappings } from "@/lib/pushDelivery";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import type { WebPushSendFn } from "@/lib/webPushSender";

export const CHAT_PUSH_CONCURRENCY = 4;

export type ChatPushDispatchInput = ChatPushEvent & {
  roomType: string;
  senderName: string;
  preview: string;
  memberUserIds?: number[] | null;
  roomName?: string | null;
  peerDisplayName?: string | null;
  peerTeam?: string | null;
  peerRole?: string | null;
};

export type ChatPushDispatchResult = {
  ok: true;
  recipients: number;
  nativeSent: number;
  webSent: number;
  skipped: boolean;
};

export type ChatNotifyPrefLoad =
  | { ok: true; prefs: Record<string, ChatNotifyMode> }
  | { ok: false; reason: "store_missing" | "query_failed" };

function isPrefStoreMissing(e: unknown): boolean {
  const rec = e && typeof e === "object" ? (e as { code?: unknown }) : {};
  if (rec.code === "P2021" || rec.code === "P2010") return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /ChatRoomNotificationPreference/i.test(msg) && /relation|table|does not exist/i.test(msg);
}

export async function listEligibleChatPushUserIds(db: PrismaClient): Promise<number[]> {
  const rows = (await db.user.findMany({
    select: {
      id: true,
      username: true,
      role: true,
      caddy: { select: { name: true, team: true, employmentStatus: true } },
    },
    take: CHAT_USERS_ALL_TAKE,
  })) as ChatUserRow[];
  return rows.filter(isInvitableChatUser).map((row) => row.id);
}

export async function loadChatNotifyPrefs(
  db: PrismaClient,
  roomId: string,
  userIds: readonly number[]
): Promise<ChatNotifyPrefLoad> {
  if (userIds.length === 0) return { ok: true, prefs: {} };
  try {
    const rows = await db.chatRoomNotificationPreference.findMany({
      where: { roomId, userId: { in: [...userIds] } },
      select: { userId: true, roomId: true, mode: true },
    });
    const byUser: Record<string, ChatNotifyMode> = {};
    for (const row of rows) {
      byUser[String(row.userId)] = resolveChatNotifyMode(row.mode);
    }
    return { ok: true, prefs: byUser };
  } catch (e) {
    if (isPrefStoreMissing(e)) return { ok: false, reason: "store_missing" };
    return { ok: false, reason: "query_failed" };
  }
}

export async function dispatchChatPush(
  db: PrismaClient,
  input: ChatPushDispatchInput,
  options?: {
    sendNative?: NativePushSendFn;
    sendWeb?: WebPushSendFn;
    eligibleUserIds?: number[];
  }
): Promise<ChatPushDispatchResult> {
  const empty = (skipped = true): ChatPushDispatchResult => ({
    ok: true,
    recipients: 0,
    nativeSent: 0,
    webSent: 0,
    skipped,
  });
  if (input.deletionType) return empty();
  const eligible =
    options?.eligibleUserIds ??
    (input.memberUserIds == null ? await listEligibleChatPushUserIds(db) : []);
  const candidates = candidateUserIdsForRoom({
    roomId: input.roomId,
    memberUserIds: input.memberUserIds,
    eligibleUserIds: eligible,
  });
  const prefLoad = await loadChatNotifyPrefs(db, input.roomId, candidates);
  if (!prefLoad.ok) return empty(true);
  const recipients = selectChatPushRecipients({
    event: input,
    candidateUserIds: candidates,
    prefs: prefLoad.prefs,
  });
  if (recipients.length === 0) return empty(false);

  const payload = buildChatPushPayload({
    roomId: input.roomId,
    roomType: input.roomType,
    roomName: input.roomName,
    peerDisplayName: input.roomType === "DM" ? input.senderName : input.peerDisplayName,
    peerTeam: input.peerTeam,
    peerRole: input.peerRole,
    senderName: input.senderName,
    preview: input.preview,
    mentionAll: input.mentionAll,
    mentioned: input.mentionUserIds.length > 0,
  });

  const tokens = await loadEnabledDevicePushTokens(db, recipients);
  const native = await deliverNativePushTokens(db, tokens, payload, {
    sendFn: options?.sendNative,
    concurrency: CHAT_PUSH_CONCURRENCY,
  });

  let webSent = 0;
  const webCreds = readWebPushSendCredentials();
  if (options?.sendWeb || (isWebPushSendConfigured() && webCreds)) {
    try {
      const webRows = await db.pushSubscription.findMany({
        where: { userId: { in: recipients }, enabled: true },
        select: {
          id: true,
          userId: true,
          endpoint: true,
          p256dh: true,
          auth: true,
          platform: true,
          userAgent: true,
        },
      });
      const endpoints = [...new Set(webRows.map((row) => row.endpoint))];
      const shared =
        endpoints.length === 0
          ? []
          : await db.pushSubscription.findMany({
              where: {
                endpoint: { in: endpoints },
                enabled: true,
                userId: { notIn: recipients },
              },
              select: { endpoint: true },
            });
      const exclusive = exclusiveChatWebPushRows(
        webRows,
        shared.map((row) => row.endpoint)
      );
      const filtered = selectWebPushMappingsAfterNativeSuccess(exclusive, native.sentUserIds);
      if (filtered.length > 0 && webCreds) {
        const web = await deliverWebPushMappings(db, filtered, payload, {
          sendFn: options?.sendWeb,
          credentials: webCreds,
          concurrency: CHAT_PUSH_CONCURRENCY,
        });
        webSent = web.sent;
      }
    } catch (e) {
      if (!isPushStoreMissing(e)) throw e;
    }
  }

  return {
    ok: true,
    recipients: recipients.length,
    nativeSent: native.sent,
    webSent,
    skipped: !canAttemptNativePushSend() && !options?.sendNative && webSent === 0,
  };
}
