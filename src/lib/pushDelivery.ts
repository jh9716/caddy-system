/**
 * Physical Web Push delivery. Dedupes by endpoint so one browser
 * subscription is sent once even when several User mappings share it.
 * Never logs endpoint, keys, or payload.
 */
import type { PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "@/lib/boardPushRecipients";
import type { WebPushSendCredentials } from "@/lib/pushVapid";
import {
  deliverWebPush,
  type WebPushPayload,
  type WebPushSendFn,
} from "@/lib/webPushSender";

export type PushDeliveryMapping = {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushDeliveryResult = {
  sent: number;
  failed: number;
  removedStale: number;
  deliveries: number;
};

function groupMappingsByEndpoint(
  mappings: readonly PushDeliveryMapping[]
): PushDeliveryMapping[][] {
  const groups = new Map<string, PushDeliveryMapping[]>();
  for (const row of mappings) {
    const existing = groups.get(row.endpoint);
    if (existing) existing.push(row);
    else groups.set(row.endpoint, [row]);
  }
  return [...groups.values()];
}

export function countUniquePushEndpoints(
  mappings: readonly Pick<PushDeliveryMapping, "endpoint">[]
): number {
  return new Set(mappings.map((row) => row.endpoint)).size;
}

export async function deliverWebPushMappings(
  db: PrismaClient,
  mappings: readonly PushDeliveryMapping[],
  payload: WebPushPayload,
  options: {
    sendFn?: WebPushSendFn;
    credentials: WebPushSendCredentials;
    concurrency: number;
  }
): Promise<PushDeliveryResult> {
  const groups = groupMappingsByEndpoint(mappings);
  let sent = 0;
  let failed = 0;
  let removedStale = 0;

  await mapWithConcurrency(groups, options.concurrency, async (group) => {
    const primary = group[0];
    if (!primary) return;
    const selectedIds = group.map((row) => row.id);
    const result = await deliverWebPush(
      {
        endpoint: primary.endpoint,
        p256dh: primary.p256dh,
        auth: primary.auth,
      },
      payload,
      { sendFn: options.sendFn, credentials: options.credentials }
    );
    if (result === "sent") {
      await db.pushSubscription.updateMany({
        where: { id: { in: selectedIds } },
        data: { lastSuccessAt: new Date() },
      });
      sent += 1;
    } else if (result === "gone") {
      await db.pushSubscription.deleteMany({
        where: { endpoint: primary.endpoint },
      });
      removedStale += 1;
    } else {
      await db.pushSubscription.updateMany({
        where: { id: { in: selectedIds } },
        data: { lastFailureAt: new Date() },
      });
      failed += 1;
    }
  });

  return {
    sent,
    failed,
    removedStale,
    deliveries: groups.length,
  };
}
