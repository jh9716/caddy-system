/**
 * 공개 계정 삭제 요청. User/Caddy를 지우지 않는다.
 * 접수만 Audit에 남기고 운영자가 확인 후 처리한다.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
          source: "web_form";
        };
      };
      select: { id: true };
    }) => Promise<{ id: number }>;
  };
};

function clip(raw: unknown, max: number): string {
  return String(raw ?? "").trim().slice(0, max);
}

export function parseAccountDeletionRequest(
  body: unknown
): AccountDeletionRequestInput {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const honeypot = clip(rec.company, 80);
  if (honeypot) {
    throw new AccountDeletionRequestError(400, "invalid_request", "요청을 처리할 수 없습니다.");
  }

  const accountIdentifier = clip(rec.accountIdentifier, 80);
  const replyEmail = clip(rec.replyEmail, 128).toLowerCase();
  const noteRaw = clip(rec.note, 500);
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
  return forwarded;
}

export async function createAccountDeletionRequest(
  db: AccountDeletionRequestDb,
  input: AccountDeletionRequestInput,
  meta: AccountDeletionRequestMeta
): Promise<{ id: number }> {
  if (meta.ip) {
    const recent = await db.audit.count({
      where: {
        action: ACCOUNT_DELETION_REQUEST_ACTION,
        ip: meta.ip,
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
  }

  return db.audit.create({
    data: {
      action: ACCOUNT_DELETION_REQUEST_ACTION,
      entity: ACCOUNT_DELETION_REQUEST_ENTITY,
      entityId: null,
      ip: meta.ip,
      payload: {
        accountIdentifier: input.accountIdentifier,
        replyEmail: input.replyEmail,
        note: input.note,
        source: "web_form",
      },
    },
    select: { id: true },
  });
}
