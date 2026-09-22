/**
 * 공개 계정 삭제 요청. User/Caddy를 지우지 않는다.
 * 접수만 Audit에 남기고 운영자가 확인 후 처리한다.
 *
 * Rate limit: Postgres Audit.count (IP 또는 "unknown", 1시간).
 * 프로세스 메모리가 아니므로 Vercel 인스턴스 사이에서도 적용된다.
 * 기본 abuse mitigation 수준이다. IP 우회를 막는 강한 보안 보장은 아니다.
 *
 * 운영자 처리 제안 (자동화 없음, migration 없음):
 * - User: anonymize + unlink. Restrict FK 때문에 hard delete 금지.
 * - kakaoUserId: unlink (null). 같은 카카오 계정은 이후 신규 User로만 로그인.
 * - DevicePushToken / PushSubscription: hard delete (알림 중단).
 * - CourseReport / Comment: 업무 기록 retain. 표시명 anonymize. authorUserId Restrict 유지.
 * - CaddyLinkRequest: 이력 retain. submittedName/phoneNormalized anonymize.
 * - Audit: retain (보안·운영 이력).
 * - Caddy: unlink only. 직원 명부/배치는 계정 삭제와 분리.
 */

export const ACCOUNT_DELETION_REQUEST_ACTION = "account_deletion_request";
export const ACCOUNT_DELETION_REQUEST_ENTITY = "User";
export const ACCOUNT_DELETION_RATE_LIMIT = 5;
export const ACCOUNT_DELETION_RATE_WINDOW_MS = 60 * 60 * 1000;
export const ACCOUNT_DELETION_IDENTIFIER_MAX = 80;
export const ACCOUNT_DELETION_EMAIL_MAX = 128;
export const ACCOUNT_DELETION_NOTE_MAX = 500;
export const ACCOUNT_DELETION_UNKNOWN_IP = "unknown";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type AccountDeletionRequestInput = {
  accountIdentifier: string;
  replyEmail: string;
  note: string | null;
};

export type AccountDeletionRequestMeta = {
  ip: string | null;
};

export class AccountDeletionRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type AccountDeletionRequestDb = {
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
          accountIdentifier: string;
          replyEmail: string;
          note: string | null;
        };
      };
      select: { id: true };
    }) => Promise<{ id: number }>;
  };
};

export function publicDeletionAcceptedBody() {
  return { ok: true as const };
}

/** 저장·표시용 평문. 태그/제어문자 제거. 길이 초과는 거절. */
export function readPlainField(
  raw: unknown,
  max: number,
  code: string,
  emptyMessage: string
): string {
  if (raw == null) return "";
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new AccountDeletionRequestError(400, code, emptyMessage);
  }
  const original = String(raw);
  if (original.length > max) {
    throw new AccountDeletionRequestError(
      400,
      "field_too_long",
      "입력 길이가 너무 깁니다."
    );
  }
  return original.replace(CONTROL_CHARS, "").replace(/[<>]/g, "").trim();
}

export function parseAccountDeletionRequest(
  body: unknown
): AccountDeletionRequestInput {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const honeypot = readPlainField(rec.company, 80, "invalid_request", "요청을 처리할 수 없습니다.");
  if (honeypot) {
    throw new AccountDeletionRequestError(400, "invalid_request", "요청을 처리할 수 없습니다.");
  }

  const accountIdentifier = readPlainField(
    rec.accountIdentifier,
    ACCOUNT_DELETION_IDENTIFIER_MAX,
    "invalid_account",
    "계정 식별 정보를 입력해 주세요."
  );
  const replyEmail = readPlainField(
    rec.replyEmail,
    ACCOUNT_DELETION_EMAIL_MAX,
    "invalid_email",
    "회신 받을 이메일을 입력해 주세요."
  ).toLowerCase();
  const noteRaw = readPlainField(
    rec.note,
    ACCOUNT_DELETION_NOTE_MAX,
    "invalid_note",
    "요청 내용을 확인해 주세요."
  );
  const note = noteRaw.length > 0 ? noteRaw : null;

  if (accountIdentifier.length < 2) {
    throw new AccountDeletionRequestError(
      400,
      "invalid_account",
      "계정 식별 정보를 입력해 주세요."
    );
  }
  if (!EMAIL_RE.test(replyEmail) || replyEmail.endsWith("@example.com")) {
    throw new AccountDeletionRequestError(
      400,
      "invalid_email",
      "회신 받을 이메일을 입력해 주세요."
    );
  }

  return { accountIdentifier, replyEmail, note };
}

export function clientIpFromRequest(headers: {
  get(name: string): string | null;
}): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  if (!forwarded || forwarded.length > 64) return null;
  return forwarded.replace(CONTROL_CHARS, "");
}

export function rateLimitIp(ip: string | null): string {
  return ip && ip.length > 0 ? ip : ACCOUNT_DELETION_UNKNOWN_IP;
}

export async function createAccountDeletionRequest(
  db: AccountDeletionRequestDb,
  input: AccountDeletionRequestInput,
  meta: AccountDeletionRequestMeta
): Promise<{ id: number }> {
  const ip = rateLimitIp(meta.ip);
  const recent = await db.audit.count({
    where: {
      action: ACCOUNT_DELETION_REQUEST_ACTION,
      ip,
      createdAt: { gte: new Date(Date.now() - ACCOUNT_DELETION_RATE_WINDOW_MS) },
    },
  });
  if (recent >= ACCOUNT_DELETION_RATE_LIMIT) {
    throw new AccountDeletionRequestError(
      429,
      "rate_limited",
      "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
    );
  }

  return db.audit.create({
    data: {
      action: ACCOUNT_DELETION_REQUEST_ACTION,
      entity: ACCOUNT_DELETION_REQUEST_ENTITY,
      entityId: null,
      ip,
      payload: {
        accountIdentifier: input.accountIdentifier,
        replyEmail: input.replyEmail,
        note: input.note,
      },
    },
    select: { id: true },
  });
}
