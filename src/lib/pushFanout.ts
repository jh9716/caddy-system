/**
 * Logical recipient userIds → Web Push + Native DevicePushToken.
 * Recipient eligibility stays in the existing resolvers.
 */
import type { PrismaClient } from "@prisma/client";
import {
  deliverWebPushMappings,
  type PushDeliveryMapping,
  type PushDeliveryResult,
} from "@/lib/pushDelivery";
import {
  deliverNativePushTokens,
  loadEnabledDevicePushTokens,
  type NativePushDeliveryResult,
  type NativePushSendFn,
} from "@/lib/nativePushDelivery";
import type { WebPushPayload, WebPushSendFn } from "@/lib/webPushSender";
import type { WebPushSendCredentials } from "@/lib/pushVapid";

export type PushFanoutResult = {
  web: PushDeliveryResult;
  native: NativePushDeliveryResult;
};

export async function fanoutPushToUserIds(
  db: PrismaClient,
  input: {
    userIds: readonly number[];
    webMappings: readonly PushDeliveryMapping[];
    payload: WebPushPayload;
    credentials: WebPushSendCredentials;
    concurrency: number;
    webSendFn?: WebPushSendFn;
    nativeSendFn?: NativePushSendFn;
  }
): Promise<PushFanoutResult> {
  const web = await deliverWebPushMappings(db, input.webMappings, input.payload, {
    sendFn: input.webSendFn,
    credentials: input.credentials,
    concurrency: input.concurrency,
  });
  const tokens = await loadEnabledDevicePushTokens(db, input.userIds);
  const native = await deliverNativePushTokens(db, tokens, input.payload, {
    sendFn: input.nativeSendFn,
    concurrency: input.concurrency,
  });
  return { web, native };
}
