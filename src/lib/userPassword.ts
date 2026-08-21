/**
 * User.password null-safe 검증 (카카오 OAuth 전용 User 대비)
 * - hash가 null/empty 이면 bcrypt를 호출하지 않고 false
 * - ID/PW 로그인은 401로 처리하도록 호출측에서 사용
 */
import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { isBannedTempNumericPassword } from "@/lib/passwordPolicy";

const BCRYPT_ROUNDS = 10;

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

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(String(plain ?? ""), BCRYPT_ROUNDS);
}

/**
 * 예측 불가능한 8자리 숫자 임시 비밀번호.
 * 평문은 호출 측에서 관리자에게 한 번만 보여주고 DB/로그/git에 남기지 않는다.
 */
export function generateTempNumericPassword(): string {
  for (let i = 0; i < 64; i++) {
    const value = String(randomInt(10_000_000, 100_000_000));
    if (!isBannedTempNumericPassword(value)) return value;
  }
  throw new Error("temp_password_generation_failed");
}

export function generateDistinctTempNumericPasswords(count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (out.length < count) {
    guard += 1;
    if (guard > count * 64) {
      throw new Error("temp_password_generation_failed");
    }
    const next = generateTempNumericPassword();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}
