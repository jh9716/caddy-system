/**
 * Best-effort Worker fanout after User.sessionVersion increments.
 * New WS/directory connections do NOT depend on this — they re-check Next.
 * This only closes already-open sockets sooner than token exp.
 */

import { chatHttpBaseUrl } from "@/lib/chatClientConfig";
import {
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_TS_HEADER,
  chatInternalSecret,
  signChatInternalAuth,
} from "@/lib/chatInternalAuth";
import { parseChatSessionEpoch } from "@/lib/chatSessionEpoch";

export const CHAT_SESSION_CHECK_PATH = "/api/chat/session-check";
export const CHAT_SESSION_REVOKE_PATH = "/internal/session-revoke";

export type ChatSessionRevokeNotifyResult = "ok" | "skipped" | "failed";

export async function notifyChatSessionRevoked(
  input: { userId: number; sessionVersion: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<ChatSessionRevokeNotifyResult> {
  const userId = Number(input.userId);
  const sessionVersion = parseChatSessionEpoch(input.sessionVersion);
  if (!Number.isInteger(userId) || userId <= 0 || sessionVersion == null) {
    return "skipped";
  }
  const worker = chatHttpBaseUrl();
  const secret = chatInternalSecret(env);
  if (!worker || !secret) return "skipped";
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(`${worker}${CHAT_SESSION_REVOKE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CHAT_INTERNAL_TS_HEADER]: String(ts),
        [CHAT_INTERNAL_AUTH_HEADER]: await signChatInternalAuth(
          secret,
          CHAT_SESSION_REVOKE_PATH,
          ts
        ),
      },
      body: JSON.stringify({ userId, sessionVersion }),
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    return res.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export async function notifyChatSessionRevokedForUser(
  db: {
    user: {
      findUnique: (args: {
        where: { id: number };
        select: { id: true; sessionVersion: true };
      }) => Promise<{ id: number; sessionVersion: number } | null>;
    };
  },
  userId: number
): Promise<ChatSessionRevokeNotifyResult> {
  if (!Number.isInteger(userId) || userId <= 0) return "skipped";
  try {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, sessionVersion: true },
    });
    if (!row) return "skipped";
    return notifyChatSessionRevoked({
      userId: row.id,
      sessionVersion: row.sessionVersion,
    });
  } catch {
    return "failed";
  }
}

export async function notifyChatSessionRevokedForCaddyLink(
  db: {
    user: {
      findMany: (args: {
        where: { caddyId: number };
        select: { id: true; sessionVersion: true };
      }) => Promise<Array<{ id: number; sessionVersion: number }>>;
    };
  },
  caddyId: number
): Promise<ChatSessionRevokeNotifyResult[]> {
  if (!Number.isInteger(caddyId) || caddyId < 1) return [];
  try {
    const rows = await db.user.findMany({
      where: { caddyId },
      select: { id: true, sessionVersion: true },
    });
    const out: ChatSessionRevokeNotifyResult[] = [];
    for (const row of rows) {
      out.push(
        await notifyChatSessionRevoked({
          userId: row.id,
          sessionVersion: row.sessionVersion,
        })
      );
    }
    return out;
  } catch {
    return ["failed"];
  }
}
