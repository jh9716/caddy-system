/**
 * Firebase Cloud Messaging HTTP v1 sender.
 * Official service-account JWT → OAuth2 access token → messages:send.
 * Tests inject fetchFn. Never logs tokens, JWT, or credentials.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { readFcmServiceAccount, type FcmServiceAccount } from "@/lib/fcmCredentials";
import { safeReturnPath } from "@/lib/safeReturnPath";
import type { WebPushPayload } from "@/lib/webPushSender";

export const FCM_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_MESSAGING_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const FCM_ANDROID_CHANNEL_ID = "verthill";

export type FcmHttpDelivery = "sent" | "failed" | "gone";

export type FcmFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export function fcmMessagesSendUrl(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signGoogleServiceAccountJwt(
  account: FcmServiceAccount,
  nowSec: number
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: account.clientEmail,
    scope: FCM_MESSAGING_SCOPE,
    aud: FCM_OAUTH_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(createPrivateKey(account.privateKey), "base64url");
  return `${unsigned}.${sig}`;
}

export function buildFcmHttpV1Message(
  token: string,
  payload: WebPushPayload
): {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
    android: {
      priority: "HIGH";
      notification: { channelId: string; title: string; body: string };
    };
  };
} {
  const data: Record<string, string> = {};
  const url = safeReturnPath(payload.url);
  if (url) data.url = url;
  if (payload.tag) data.tag = String(payload.tag);
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data,
      android: {
        priority: "HIGH",
        notification: {
          channelId: FCM_ANDROID_CHANNEL_ID,
          title: payload.title,
          body: payload.body,
        },
      },
    },
  };
}

function readErrorCode(body: unknown): { status: string; errorCode: string; message: string } {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const err = rec.error && typeof rec.error === "object" ? (rec.error as Record<string, unknown>) : {};
  const status = String(err.status ?? "");
  const message = String(err.message ?? "");
  let errorCode = "";
  const details = Array.isArray(err.details) ? err.details : [];
  for (const item of details) {
    if (item && typeof item === "object") {
      const code = String((item as { errorCode?: unknown }).errorCode ?? "");
      if (code) {
        errorCode = code;
        break;
      }
    }
  }
  return { status, errorCode, message };
}

export function classifyFcmHttpResponse(status: number, body: unknown): FcmHttpDelivery {
  if (status >= 200 && status < 300) return "sent";
  if (status === 429 || status >= 500) return "failed";
  const parsed = readErrorCode(body);
  if (
    parsed.errorCode === "UNREGISTERED" ||
    parsed.status === "NOT_FOUND" ||
    status === 404 ||
    status === 410
  ) {
    return "gone";
  }
  if (parsed.errorCode === "UNAVAILABLE" || parsed.status === "UNAVAILABLE") {
    return "failed";
  }
  if (parsed.errorCode === "RESOURCE_EXHAUSTED" || parsed.status === "RESOURCE_EXHAUSTED") {
    return "failed";
  }
  if (
    parsed.errorCode === "UNREGISTERED" ||
    /unregistered|not a valid fcm registration token|registration token/i.test(
      parsed.message
    )
  ) {
    return "gone";
  }
  return "failed";
}

async function fetchOauthAccessToken(
  account: FcmServiceAccount,
  fetchFn: FcmFetchFn,
  nowSec: number
): Promise<string | null> {
  const assertion = signGoogleServiceAccountJwt(account, nowSec);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();
  const res = await fetchFn(FCM_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status < 200 || res.status >= 300) return null;
  const json = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = String(json.access_token ?? "").trim();
  return token || null;
}

export async function sendFcmHttpV1(
  token: string,
  payload: WebPushPayload,
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchFn?: FcmFetchFn;
    nowSec?: number;
  }
): Promise<FcmHttpDelivery> {
  const account = readFcmServiceAccount(options?.env ?? process.env);
  if (!account) return "failed";
  const fetchFn = options?.fetchFn ?? (async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, json: () => res.json() };
  });
  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  let access: string | null;
  try {
    access = await fetchOauthAccessToken(account, fetchFn, nowSec);
  } catch {
    return "failed";
  }
  if (!access) return "failed";
  const url = fcmMessagesSendUrl(account.projectId);
  const message = buildFcmHttpV1Message(token, payload);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
    const json = await res.json().catch(() => ({}));
    return classifyFcmHttpResponse(res.status, json);
  } catch {
    return "failed";
  }
}
