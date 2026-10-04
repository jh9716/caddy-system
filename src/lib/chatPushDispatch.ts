/**
 * One chat message → one backend dispatch.
 * Batch-resolve prefs/tokens, then reuse existing native/web senders.
 */
import type { PrismaClient } from "@prisma/client";
import { buildChatPushPayload } from "@/lib/chatPushMessage";
import {
  candidateUserIdsForRoom,
  selectChatPushRecipients,
  type ChatPushEvent,
} from "@/lib/chatPushRecipients";
import { chatNotifyPrefMap, type ChatNotifyMode } from "@/lib/chatNotificationPref";
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

function isPrefStoreMissing(e: unknown): boolean {
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
): Promise<Record<string, ChatNotifyMode>> {
  if (userIds.length === 0) return {};
  try {
    const rows = await db.chatRoomNotificationPreference.findMany({
      where: { roomId, userId: { in: [...userIds] } },
      select: { userId: true, roomId: true, mode: true },
    });
    const byUser: Record<string, ChatNotifyMode> = {};
    const mapped = chatNotifyPrefMap(
      rows.map((row) => ({ roomId: row.roomId, mode: String(row.mode) }))
    );
    for (const row of rows) {
      byUser[String(row.userId)] = mapped[row.roomId] ?? "ALL";
    }
    return byUser;
  } catch (e) {
    if (isPrefStoreMissing(e)) return {};
    throw e;
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
  const prefs = await loadChatNotifyPrefs(db, input.roomId, candidates);
  const recipients = selectChatPushRecipients({
    event: input,
    candidateUserIds: candidates,
    prefs,
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
      const filtered = selectWebPushMappingsAfterNativeSuccess(webRows, native.sentUserIds);
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
