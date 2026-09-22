/**
 * 관리자 개인정보 요청 inbox.
 * 기존 Audit만 읽는다. schema/migration 없음.
 * 실제 User 삭제·익명화는 하지 않는다.
 */

import { ACCOUNT_DELETION_REQUEST_ACTION } from "@/lib/accountDeletionRequest";
import {
  PRIVACY_INQUIRY_ACTION,
  PRIVACY_INQUIRY_TOPIC_LABELS,
  type PrivacyInquiryTopic,
} from "@/lib/privacyInquiryRequest";

export const PRIVACY_REQUEST_ACTIONS = [
  ACCOUNT_DELETION_REQUEST_ACTION,
  PRIVACY_INQUIRY_ACTION,
] as const;

export const PRIVACY_REQUESTS_ADMIN_LIMIT = 200;

export type AdminPrivacyRequestRow = {
  id: number;
  createdAt: string;
  kind: string;
  accountIdentifier: string | null;
  replyEmail: string | null;
  topic: string | null;
  note: string | null;
};

export type PrivacyRequestInboxDb = {
  audit: {
    findMany: (args: {
      where: { action: { in: string[] } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: {
        id: true;
        action: true;
        createdAt: true;
        payload: true;
      };
    }) => Promise<
      Array<{
        id: number;
        action: string;
        createdAt: Date;
        payload: unknown;
      }>
    >;
  };
};

function asPlain(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function toAdminPrivacyRequestRow(row: {
  id: number;
  action: string;
  createdAt: Date;
  payload: unknown;
}): AdminPrivacyRequestRow {
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : {};
  const topic =
    asPlain(payload.topic) ||
    (row.action === ACCOUNT_DELETION_REQUEST_ACTION ? "account_deletion" : null);
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: row.action,
    accountIdentifier: asPlain(payload.accountIdentifier),
    replyEmail: asPlain(payload.replyEmail),
    topic,
    note: asPlain(payload.note) ?? asPlain(payload.message),
  };
}

export function privacyRequestKindLabel(kind: string): string {
  if (kind === ACCOUNT_DELETION_REQUEST_ACTION) return "계정 삭제 요청";
  if (kind === PRIVACY_INQUIRY_ACTION) return "개인정보 문의";
  return kind;
}

export function privacyRequestTopicLabel(topic: string | null): string {
  if (!topic) return "—";
  if (topic in PRIVACY_INQUIRY_TOPIC_LABELS) {
    return PRIVACY_INQUIRY_TOPIC_LABELS[topic as PrivacyInquiryTopic];
  }
  return topic;
}

export async function listPrivacyRequests(
  db: PrivacyRequestInboxDb
): Promise<AdminPrivacyRequestRow[]> {
  const rows = await db.audit.findMany({
    where: { action: { in: [...PRIVACY_REQUEST_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: PRIVACY_REQUESTS_ADMIN_LIMIT,
    select: {
      id: true,
      action: true,
      createdAt: true,
      payload: true,
    },
  });
  return rows.map(toAdminPrivacyRequestRow);
}
