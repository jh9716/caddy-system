/** 경기과 직원 개인 관리자 계정 (username = 한글 이름). */
export const STAFF_ADMIN_USERNAMES = [
  "박성민",
  "이기흥",
  "구건호",
  "지창욱",
  "이성인",
] as const;

export type StaffAdminUsername = (typeof STAFF_ADMIN_USERNAMES)[number];

/** DB 최고관리자. 직원 계정 관리만 이 계정(+ env-only admin)에 허용. */
export const SUPER_ADMIN_USERNAME = "admin";

/**
 * 직원 계정 목록/재설정 권한.
 * - DB User: username === "admin" 이고 role=admin
 * - env-only admin (userId/uid null): ADMIN_USER 값과 무관하게 동일 허용
 * 경기과 직원 admin(박성민 등)은 false.
 */
export function isAccountManagerAuth(input: {
  role?: string | null;
  username?: string | null;
  userId?: number | null;
  uid?: number | null;
}): boolean {
  const role = String(input.role ?? "").trim().toLowerCase();
  if (role !== "admin") return false;
  const userId = input.userId ?? input.uid ?? null;
  if (userId == null) return true;
  return String(input.username ?? "") === SUPER_ADMIN_USERNAME;
}

/** 카카오 OAuth 전용 User와 섞지 않는다. password 있는 ID/PW 계정만. */
export const STAFF_PASSWORD_ACCOUNT_WHERE = {
  password: { not: null },
  kakaoUserId: null,
} as const;
