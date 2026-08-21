/** 경기과 직원 개인 관리자 계정 (username = 한글 이름). */
export const STAFF_ADMIN_USERNAMES = [
  "박성민",
  "이기흥",
  "구건호",
  "지창욱",
  "이성인",
] as const;

export type StaffAdminUsername = (typeof STAFF_ADMIN_USERNAMES)[number];

/** 카카오 OAuth 전용 User와 섞지 않는다. password 있는 ID/PW 계정만. */
export const STAFF_PASSWORD_ACCOUNT_WHERE = {
  password: { not: null },
  kakaoUserId: null,
} as const;
