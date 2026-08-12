/**
 * Caddy 휴대폰 정규화 / 마스킹
 * DB canonical: 010XXXXXXXX (숫자 11자리)
 */

export class CaddyPhoneError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "invalid_phone"
  ) {
    super(message);
    this.name = "CaddyPhoneError";
  }
}

/** 빈 입력 → null. 유효 → 010XXXXXXXX. 무효 → throw CaddyPhoneError */
export function parseOptionalPhoneInput(
  input: unknown
): string | null {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  if (raw === "") return null;
  return normalizeKrMobile(raw);
}

/**
 * 한국 휴대폰을 010XXXXXXXX 로 통일.
 * 허용 예: 010-1234-5678, 01012345678, +82 10 1234 5678, 82 10...
 */
export function normalizeKrMobile(input: string): string {
  let s = String(input ?? "").trim();
  if (!s) {
    throw new CaddyPhoneError("휴대폰번호를 입력해 주세요.");
  }

  // 시각적 구분 문자 제거
  s = s.replace(/[\s\-().]/g, "");

  // +82 / 82 국가코드 → 0…
  if (s.startsWith("+82")) {
    s = `0${s.slice(3)}`;
  } else if (s.startsWith("82") && (s.length === 12 || s.length === 11)) {
    // 8210xxxxxxxx (12) or rare 821xxxxxxxx
    s = `0${s.slice(2)}`;
  }

  // 10xxxxxxxx (10자리) → 010xxxxxxxx
  if (/^10\d{8}$/.test(s)) {
    s = `0${s}`;
  }

  if (!/^010\d{8}$/.test(s)) {
    throw new CaddyPhoneError(
      "유효한 휴대폰번호가 아닙니다. 예: 010-1234-5678"
    );
  }

  return s;
}

/** 목록/상세 표시용: 010-****-5678 (null → null) */
export function maskKrMobile(
  phoneNormalized: string | null | undefined
): string | null {
  if (phoneNormalized == null || phoneNormalized === "") return null;
  if (!/^010\d{8}$/.test(phoneNormalized)) return "010-****-****";
  return `010-****-${phoneNormalized.slice(7)}`;
}

/** Prisma P2002 target 이 phoneNormalized 인지 */
export function isPhoneUniqueViolation(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: { target?: string | string[] };
    message?: string;
  };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) {
    return target.some((t) => String(t).includes("phoneNormalized"));
  }
  if (typeof target === "string") {
    return target.includes("phoneNormalized");
  }
  return String(e.message ?? "").includes("phoneNormalized");
}
