/**
 * User.password null-safe 검증 (카카오 OAuth 전용 User 대비)
 * - hash가 null/empty 이면 bcrypt를 호출하지 않고 false
 * - ID/PW 로그인은 401로 처리하도록 호출측에서 사용
 */
import bcrypt from "bcryptjs";

export function hasPasswordHash(
  hash: string | null | undefined
): hash is string {
  return typeof hash === "string" && hash.length > 0;
}

/** password null인 User → false (예외 없음). 유효 해시만 bcrypt.compare */
export async function verifyUserPassword(
  plain: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hasPasswordHash(hash)) return false;
  return bcrypt.compare(plain, hash);
}
