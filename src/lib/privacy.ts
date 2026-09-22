/**
 * 공개 개인정보처리방침 / 계정 삭제 요청 경로.
 * native / PWA / web 모두 같은 origin path를 쓴다.
 * 문의 이메일은 PRIVACY_CONTACT_EMAIL env만 사용한다. 코드에 이메일을 하드코딩하지 않는다.
 */
export const PRIVACY_PATH = "/privacy";
export const PRIVACY_PUBLIC_URL = "https://www.verthill.kr/privacy";
export const PRIVACY_LINK_LABEL = "개인정보처리방침";
export const PRIVACY_SERVICE_NAME = "VERTHILL";
export const PRIVACY_OPERATOR_NAME = "VERTHILL";
export const PRIVACY_EFFECTIVE_DATE = "2026-09-22";
export const PRIVACY_CONTACT_EMAIL_ENV = "PRIVACY_CONTACT_EMAIL";

export const ACCOUNT_DELETION_PATH = "/account-deletion";
export const ACCOUNT_DELETION_PUBLIC_URL =
  "https://www.verthill.kr/account-deletion";
export const ACCOUNT_DELETION_LINK_LABEL = "계정 삭제 요청";

export const PRIVACY_CONTACT_PATH = "/privacy-contact";
export const PRIVACY_CONTACT_PUBLIC_URL =
  "https://www.verthill.kr/privacy-contact";
export const PRIVACY_CONTACT_LINK_LABEL = "개인정보 문의";
export const PRIVACY_REQUESTS_ADMIN_PATH = "/manage/privacy-requests";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** env에 유효한 문의 이메일이 있을 때만 반환. 없으면 null. */
export function readPrivacyContactEmail(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string | null {
  const raw = String(env[PRIVACY_CONTACT_EMAIL_ENV] ?? "").trim();
  if (!raw || raw.length > 128) return null;
  if (!EMAIL_RE.test(raw)) return null;
  const lower = raw.toLowerCase();
  if (lower.endsWith("@example.com") || lower.endsWith(".example")) return null;
  return raw;
}
