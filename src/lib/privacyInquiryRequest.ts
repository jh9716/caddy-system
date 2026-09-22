/**
 * 공개 개인정보 문의. User 조회/삭제를 하지 않는다.
 * 접수만 Audit(privacy_inquiry)에 남긴다.
 * 계정 삭제 유형은 기존 account_deletion_request 검증·저장을 재사용한다.
 *
 * Rate limit: Postgres Audit.count (IP 또는 "unknown", 1시간).
 * 프로세스 메모리가 아니므로 Vercel 인스턴스 사이에서도 적용된다.
 * 기본 abuse mitigation 수준이다. 강한 보안 보장은 아니다.
 */

import {
  ACCOUNT_DELETION_EMAIL_MAX,
  ACCOUNT_DELETION_NOTE_MAX,
  ACCOUNT_DELETION_RATE_LIMIT,
  ACCOUNT_DELETION_RATE_WINDOW_MS,
  AccountDeletionRequestError,
  parseAccountDeletionRequest,
  publicDeletionAcceptedBody,
  rateLimitIp,
  readPlainField,
  type AccountDeletionRequestInput,
} from "@/lib/accountDeletionRequest";

export const PRIVACY_INQUIRY_ACTION = "privacy_inquiry";
export const PRIVACY_INQUIRY_ENTITY = "PrivacyInquiry";
export const PRIVACY_INQUIRY_RATE_LIMIT = ACCOUNT_DELETION_RATE_LIMIT;
export const PRIVACY_INQUIRY_RATE_WINDOW_MS = ACCOUNT_DELETION_RATE_WINDOW_MS;
export const PRIVACY_INQUIRY_MESSAGE_MAX = ACCOUNT_DELETION_NOTE_MAX;

export const PRIVACY_INQUIRY_TOPICS = [
  "privacy_inquiry",
  "access_or_correction",
  "account_deletion",
] as const;

export type PrivacyInquiryTopic = (typeof PRIVACY_INQUIRY_TOPICS)[number];

export const PRIVACY_INQUIRY_TOPIC_LABELS: Record<PrivacyInquiryTopic, string> = {
  privacy_inquiry: "개인정보 문의",
  access_or_correction: "열람 또는 정정",
  account_deletion: "계정 삭제",
};

export type PrivacyInquiryRequestInput = {
  replyEmail: string;
  topic: Exclude<PrivacyInquiryTopic, "account_deletion">;
  message: string;
};

export type ParsedPrivacyInquiry =
  | { kind: "inquiry"; input: PrivacyInquiryRequestInput }
  | { kind: "deletion"; input: AccountDeletionRequestInput };

export type PrivacyInquiryRequestMeta = {
  ip: string | null;
};

export type PrivacyInquiryRequestDb = {
  audit: {
    count: (args: {
      where: {
        action: string;
        ip: string;
        createdAt: { gte: Date };
      };
    }) => Promise<number>;
    create: (args: {
      data: {
        action: string;
        entity: string;
        entityId: null;
        ip: string | null;
        payload: {
          replyEmail: string;
          topic: string;
          message: string;
        };
      };
      select: { id: true };
    }) => Promise<{ id: number }>;
  };
};

export function publicPrivacyInquiryAcceptedBody() {
  return publicDeletionAcceptedBody();
}

export function isPrivacyInquiryTopic(value: string): value is PrivacyInquiryTopic {
  return (PRIVACY_INQUIRY_TOPICS as readonly string[]).includes(value);
}

export function parsePrivacyInquiryRequest(body: unknown): ParsedPrivacyInquiry {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const honeypot = readPlainField(rec.company, 80, "invalid_request", "요청을 처리할 수 없습니다.");
  if (honeypot) {
    throw new AccountDeletionRequestError(400, "invalid_request", "요청을 처리할 수 없습니다.");
  }

  const topic = readPlainField(
    rec.topic,
    40,
    "invalid_topic",
    "문의 유형을 선택해 주세요."
  );
  if (!isPrivacyInquiryTopic(topic)) {
    throw new AccountDeletionRequestError(400, "invalid_topic", "문의 유형을 선택해 주세요.");
  }

  if (topic === "account_deletion") {
    return {
      kind: "deletion",
      input: parseAccountDeletionRequest({
        accountIdentifier: rec.accountIdentifier,
        replyEmail: rec.replyEmail,
        note: rec.message ?? rec.note,
      }),
    };
  }

  const replyEmail = readPlainField(
    rec.replyEmail,
    ACCOUNT_DELETION_EMAIL_MAX,
    "invalid_email",
    "회신 받을 이메일을 입력해 주세요."
  ).toLowerCase();
  const message = readPlainField(
    rec.message,
    PRIVACY_INQUIRY_MESSAGE_MAX,
    "invalid_message",
    "문의 내용을 입력해 주세요."
  );

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail) || replyEmail.endsWith("@example.com")) {
    throw new AccountDeletionRequestError(
      400,
      "invalid_email",
      "회신 받을 이메일을 입력해 주세요."
    );
  }
  if (message.length < 2) {
    throw new AccountDeletionRequestError(
      400,
      "invalid_message",
      "문의 내용을 입력해 주세요."
    );
  }

  return { kind: "inquiry", input: { replyEmail, topic, message } };
}

export async function createPrivacyInquiryRequest(
  db: PrivacyInquiryRequestDb,
  input: PrivacyInquiryRequestInput,
  meta: PrivacyInquiryRequestMeta
): Promise<{ id: number }> {
  const ip = rateLimitIp(meta.ip);
  const recent = await db.audit.count({
    where: {
      action: PRIVACY_INQUIRY_ACTION,
      ip,
      createdAt: { gte: new Date(Date.now() - PRIVACY_INQUIRY_RATE_WINDOW_MS) },
    },
  });
  if (recent >= PRIVACY_INQUIRY_RATE_LIMIT) {
    throw new AccountDeletionRequestError(
      429,
      "rate_limited",
      "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
    );
  }

  return db.audit.create({
    data: {
      action: PRIVACY_INQUIRY_ACTION,
      entity: PRIVACY_INQUIRY_ENTITY,
      entityId: null,
      ip,
      payload: {
        replyEmail: input.replyEmail,
        topic: input.topic,
        message: input.message,
      },
    },
    select: { id: true },
  });
}
