import webpush from "web-push";
import {
  readWebPushSendCredentials,
  type WebPushSendCredentials,
} from "@/lib/pushVapid";

export {
  TEST_PUSH_CONFIRM,
  TEST_PUSH_TITLE,
  TEST_PUSH_BODY,
  TEST_PUSH_URL,
} from "@/lib/webPushTestConstants";

export type WebPushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type WebPushPayload = {
  title: string;
  body: string;
  url: string;
  tag?: string;
};

export type WebPushDelivery = "sent" | "failed" | "gone";

export type WebPushSendFn = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string
) => Promise<unknown>;

function statusCodeOf(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const rec = e as { statusCode?: unknown; status?: unknown };
  if (typeof rec.statusCode === "number") return rec.statusCode;
  if (typeof rec.status === "number") return rec.status;
  return null;
}

export function isGoneStatus(statusCode: number | null): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Send one Web Push. Never logs endpoint, keys, payload, or provider body.
 */
export async function deliverWebPush(
  subscription: WebPushSubscriptionKeys,
  payload: WebPushPayload,
  options?: { sendFn?: WebPushSendFn; credentials?: WebPushSendCredentials | null }
): Promise<WebPushDelivery> {
  const creds = options?.credentials ?? readWebPushSendCredentials();
  if (!creds) return "failed";
  const json = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    ...(payload.tag ? { tag: payload.tag } : {}),
  });
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  try {
    if (options?.sendFn) {
      await options.sendFn(pushSubscription, json);
    } else {
      webpush.setVapidDetails(creds.subject, creds.publicKey, creds.privateKey);
      await webpush.sendNotification(pushSubscription, json);
    }
    return "sent";
  } catch (e) {
    if (isGoneStatus(statusCodeOf(e))) return "gone";
    return "failed";
  }
}
