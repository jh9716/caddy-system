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

export const STAFF_CREATE_USERNAME_MAX = 64;

export type StaffCreateUsernameIssue =
  | "empty"
  | "too_long"
  | "reserved_admin"
  | "reserved_kakao"
  | "reserved_playreview"
  | "reserved_env";

export function normalizeStaffCreateUsername(raw: unknown): string {
  return String(raw ?? "").trim();
}

function envUsername(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Env ID/PW 계정과 겹치면 passwordLogin이 env를 먼저 매칭한다.
 * ADMIN_USER / CADDY_USER(및 alias)와, 비밀번호가 켜진 env 기본 아이디를 예약한다.
 */
export function reservedEnvUsernames(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const reserved = new Set<string>();
  const adminUser = envUsername(env, "ADMIN_USER");
  const adminUsername = envUsername(env, "ADMIN_USERNAME");
  const caddyUser = envUsername(env, "CADDY_USER");
  const caddyUsername = envUsername(env, "CADDY_USERNAME");
  if (adminUser) reserved.add(adminUser);
  if (adminUsername) reserved.add(adminUsername);
  if (caddyUser) reserved.add(caddyUser);
  if (caddyUsername) reserved.add(caddyUsername);
  if (typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length > 0) {
    reserved.add(adminUser || adminUsername || SUPER_ADMIN_USERNAME);
  }
  if (typeof env.CADDY_PASSWORD === "string" && env.CADDY_PASSWORD.length > 0) {
    reserved.add(caddyUser || caddyUsername || "caddy");
  }
  return [...reserved];
}

export function staffCreateUsernameIssue(
  username: string,
  env: NodeJS.ProcessEnv = process.env
): StaffCreateUsernameIssue | null {
  if (!username) return "empty";
  if (username.length > STAFF_CREATE_USERNAME_MAX) return "too_long";
  if (username === SUPER_ADMIN_USERNAME) return "reserved_admin";
  const lower = username.toLowerCase();
  if (lower.startsWith("kakao_")) return "reserved_kakao";
  if (lower.startsWith("playreview_")) return "reserved_playreview";
  if (reservedEnvUsernames(env).includes(username)) return "reserved_env";
  return null;
}

export function staffCreateUsernameIssueMessage(
  issue: StaffCreateUsernameIssue
): string {
  switch (issue) {
    case "empty":
      return "아이디를 입력해 주세요.";
    case "too_long":
      return "아이디가 너무 깁니다.";
    case "reserved_admin":
      return "최고관리자 아이디는 생성할 수 없습니다.";
    case "reserved_kakao":
      return "카카오 계정 아이디는 사용할 수 없습니다.";
    case "reserved_playreview":
      return "예약된 아이디는 사용할 수 없습니다.";
    case "reserved_env":
      return "환경변수 계정과 같은 아이디는 만들 수 없습니다.";
  }
}
